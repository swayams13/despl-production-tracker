import { withTenant, type Tx } from "@/lib/db";
import { hasRole, ROLES, type Actor } from "@/lib/authz";
import { jointRefs } from "@/lib/shared/floor-rules";
import {
  ageDaysOf,
  classRank,
  QC_VIEW_ROLES,
  compareHolds,
  groupByJobUnit,
  holdIsReached,
  isTestPoint,
  pageOf,
  resolveHoldPointStatus,
  type HoldRow,
  type JobGroup,
  type LatestAttempt,
  type NcrQueueRow,
  type QcCounts,
  type QcQuery,
  type ReadyRow,
} from "@/lib/shared/qc-queue";
import { ncrTenantScope } from "./ncr.service";

/**
 * Lean Core L2.6: the QC queue behind `/qc`. Three lists, one definition each,
 * shared by the page and by every count that links to it (AUD-041), all
 * scoped to the tenant and optionally one job / unit in SQL, never
 * "everything in the tenant, sorted in the browser" (AUD-018).
 *
 * - **Ready to inspect**: work waiting for QC. A SUBMITTED assembly step,
 *   component operation or (non-derived) process plan; an INSPECTION step
 *   whose preceding work on the same joint is all SUBMITTED or COMPLETE
 *   (what `inspect` needs, INSPECT_PRECONDITION). Waiting since = the last
 *   submit event.
 * - **Open holds**: blocking QCP points the gate (`openQcpItemIdsForUnit`)
 *   still treats as open, once QC can act on them: the point has an attempt,
 *   its unit's plan has started, or its planned start has passed. A point
 *   nobody has reached is upcoming, not a hold; it would bury the list under
 *   hundreds of "Pending" rows on a fresh job. Sorted H > R&A > W, then age.
 * - **NCRs**: every NCR not yet CLOSED, oldest first.
 *
 * ponytail: lists are built whole then paged in memory. Bounded by one
 * tenant's active jobs' open items; move the paging into SQL if one job's
 * open hold points ever reach the tens of thousands.
 */

export interface QcAccess {
  /** May open /qc at all. */
  view: boolean;
  /** Accept / Reject (inspect), record a hold point: QC only. */
  inspect: boolean;
  /** Approve a pending waiver (invariant 4). */
  waive: boolean;
  /** Disposition an NCR (QC; a rule NCR only by repair). */
  disposition: boolean;
  /** Accept a rule NCR as a concession (the Production Head). */
  concede: boolean;
  /** Ratify a concession. */
  ratify: boolean;
}

export function resolveQcAccess(actor: Actor): QcAccess {
  const view = actor.clientId === null && hasRole(actor, ...QC_VIEW_ROLES);
  return {
    view,
    inspect: view && hasRole(actor, ROLES.QC),
    waive: view && hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN),
    disposition: view && hasRole(actor, ROLES.QC),
    concede: view && hasRole(actor, ROLES.PRODUCTION_HEAD),
    ratify: view && hasRole(actor, ROLES.QC),
  };
}

export interface QcQueueView {
  access: QcAccess;
  query: QcQuery;
  counts: QcCounts;
  /** Active jobs, for the filter. */
  jobs: Array<{ id: number; jobNumber: string }>;
  /** The unit filter's serial, for its chip. */
  unitSerial: string | null;
  total: number;
  page: number;
  pages: number;
  ready: JobGroup<ReadyRow>[];
  holds: JobGroup<HoldRow>[];
  ncrs: JobGroup<NcrQueueRow>[];
}

interface Scope {
  tenantId: number;
  jobId: number | null;
  unitId: number | null;
}

const SUBMIT_EVENTS = ["WorkDone", "ProcessSubmitted", "AssemblyStepSubmitted", "ComponentOperationSubmitted"];

/** Latest submit event per `Type:id`, one indexed lookup for a whole page of candidates. */
async function lastSubmitted(tx: Tx, tenantId: number, items: Array<{ type: string; id: number }>): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (items.length === 0) return out;
  const types = [...new Set(items.map((i) => i.type))];
  const ids = [...new Set(items.map((i) => String(i.id)))];
  const rows = await tx.$queryRaw<Array<{ aggregate_type: string; aggregate_id: string; at: Date }>>`
    SELECT aggregate_type, aggregate_id, max(at) AS at
    FROM domain_events
    WHERE tenant_id = ${tenantId}
      AND aggregate_type = ANY(${types}::text[])
      AND aggregate_id = ANY(${ids}::text[])
      AND type = ANY(${SUBMIT_EVENTS}::text[])
    GROUP BY aggregate_type, aggregate_id
  `;
  for (const r of rows) out.set(`${r.aggregate_type}:${r.aggregate_id}`, r.at);
  return out;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function buildReady(tx: Tx, s: Scope, now: Date): Promise<ReadyRow[]> {
  const jobFilter = s.jobId ? { jobId: s.jobId } : {};
  const unitFilter = s.unitId ? { unitId: s.unitId } : {};
  const tenantUnit = { unit: { equipment: { job: { tenantId: s.tenantId, status: { in: ["ACTIVE" as const, "ON_HOLD" as const] } } } } };

  const [submittedSteps, submittedOps, submittedPlans, inspections] = await Promise.all([
    tx.assemblyStep.findMany({
      where: { status: "SUBMITTED", ...jobFilter, ...unitFilter, ...tenantUnit },
      select: {
        id: true,
        jobId: true,
        unitId: true,
        reportedFinishAt: true,
        submitter: { select: { name: true } },
        templateStep: { select: { activity: true, groupCode: true } },
        unit: { select: { serialNo: true, equipment: { select: { job: { select: { jobNumber: true } } } } } },
      },
    }),
    tx.componentOperation.findMany({
      where: {
        status: "SUBMITTED",
        ...jobFilter,
        component: { equipment: { job: { tenantId: s.tenantId, status: { in: ["ACTIVE", "ON_HOLD"] } } }, ...(s.unitId ? { unitId: s.unitId } : {}) },
      },
      select: {
        id: true,
        jobId: true,
        reportedFinishAt: true,
        submitter: { select: { name: true } },
        operation: { select: { name: true } },
        component: {
          select: {
            tag: true,
            unitId: true,
            unit: { select: { serialNo: true } },
            equipment: { select: { job: { select: { jobNumber: true } } } },
          },
        },
      },
    }),
    tx.processPlan.findMany({
      where: {
        status: "SUBMITTED",
        tenantId: s.tenantId,
        scheduleRun: { isCurrent: true },
        job: { status: { in: ["ACTIVE", "ON_HOLD"] } },
        ...jobFilter,
        ...unitFilter,
      },
      select: {
        id: true,
        jobId: true,
        unitId: true,
        reportedFinishAt: true,
        submitter: { select: { name: true } },
        ownerDepartment: { select: { name: true } },
        jobProcess: { select: { name: true, workOrderStages: true } },
        unit: { select: { serialNo: true } },
        job: { select: { jobNumber: true } },
      },
    }),
    // Not yet complete INSPECTION steps: ready only if their preceding work is in (below).
    tx.assemblyStep.findMany({
      where: {
        status: { in: ["NOT_STARTED", "IN_PROGRESS"] },
        templateStep: { kind: "INSPECTION" },
        ...jobFilter,
        ...unitFilter,
        ...tenantUnit,
      },
      select: {
        id: true,
        jobId: true,
        unitId: true,
        seq: true,
        jointRef: true,
        templateStep: { select: { activity: true, groupCode: true } },
        unit: { select: { serialNo: true, equipment: { select: { job: { select: { jobNumber: true } } } } } },
      },
    }),
  ]);

  // Inspection steps: the preceding WORK steps of the same group (same joint where named), as `inspect` reads them.
  const inspUnits = [...new Set(inspections.map((i) => i.unitId))];
  const work = inspUnits.length
    ? await tx.assemblyStep.findMany({
        where: { unitId: { in: inspUnits }, templateStep: { kind: "WORK" } },
        select: { id: true, unitId: true, seq: true, status: true, jointRef: true, templateStep: { select: { groupCode: true } } },
      })
    : [];
  const workByUnit = new Map<number, typeof work>();
  for (const w of work) (workByUnit.get(w.unitId) ?? workByUnit.set(w.unitId, []).get(w.unitId)!).push(w);
  const readyInspections = inspections
    .map((i) => {
      const group = (workByUnit.get(i.unitId) ?? []).filter((w) => w.seq < i.seq && w.templateStep.groupCode === i.templateStep.groupCode);
      const own = jointRefs(i.jointRef);
      const makers = own.length ? group.filter((w) => jointRefs(w.jointRef).some((j) => own.includes(j))) : group;
      const ready = makers.length > 0 && makers.every((m) => m.status === "SUBMITTED" || m.status === "COMPLETE");
      return ready ? { step: i, makerIds: makers.map((m) => m.id) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  const when = await lastSubmitted(tx, s.tenantId, [
    ...submittedSteps.map((r) => ({ type: "AssemblyStep", id: r.id })),
    ...submittedOps.map((r) => ({ type: "ComponentOperation", id: r.id })),
    ...submittedPlans.map((r) => ({ type: "ProcessPlan", id: r.id })),
    ...readyInspections.flatMap((r) => r.makerIds.map((id) => ({ type: "AssemblyStep", id }))),
  ]);

  const rows: ReadyRow[] = [];
  const push = (r: Omit<ReadyRow, "ageDays" | "waitingSince"> & { since: Date | null }) => {
    const { since, ...rest } = r;
    rows.push({ ...rest, waitingSince: iso(since), ageDays: ageDaysOf(since, now) });
  };
  for (const r of submittedSteps) {
    push({
      key: `AS:${r.id}`,
      kind: "ASSEMBLY_STEP",
      id: r.id,
      jobId: r.jobId,
      jobNumber: r.unit.equipment.job.jobNumber,
      unitId: r.unitId,
      serialNo: r.unit.serialNo,
      title: r.templateStep.activity,
      group: r.templateStep.groupCode ?? "",
      deptName: null,
      makerName: r.submitter?.name ?? null,
      inspection: false,
      since: when.get(`AssemblyStep:${r.id}`) ?? r.reportedFinishAt,
    });
  }
  for (const r of submittedOps) {
    push({
      key: `CO:${r.id}`,
      kind: "COMPONENT_OP",
      id: r.id,
      jobId: r.jobId,
      jobNumber: r.component.equipment.job.jobNumber,
      unitId: r.component.unitId,
      serialNo: r.component.unit?.serialNo ?? null,
      title: r.operation.name,
      group: r.component.tag,
      deptName: null,
      makerName: r.submitter?.name ?? null,
      inspection: false,
      since: when.get(`ComponentOperation:${r.id}`) ?? r.reportedFinishAt,
    });
  }
  for (const r of submittedPlans) {
    push({
      key: `PP:${r.id}`,
      kind: "PROCESS_PLAN",
      id: r.id,
      jobId: r.jobId,
      jobNumber: r.job.jobNumber,
      unitId: r.unitId,
      serialNo: r.unit?.serialNo ?? null,
      title: r.jobProcess.name,
      group: "",
      deptName: r.ownerDepartment.name,
      makerName: r.submitter?.name ?? null,
      inspection: false,
      since: when.get(`ProcessPlan:${r.id}`) ?? r.reportedFinishAt,
    });
  }
  for (const { step, makerIds } of readyInspections) {
    const times = makerIds.map((id) => when.get(`AssemblyStep:${id}`)).filter((d): d is Date => d != null);
    push({
      key: `IN:${step.id}`,
      kind: "ASSEMBLY_STEP",
      id: step.id,
      jobId: step.jobId,
      jobNumber: step.unit.equipment.job.jobNumber,
      unitId: step.unitId,
      serialNo: step.unit.serialNo,
      title: step.templateStep.activity,
      group: step.templateStep.groupCode ?? "",
      deptName: null,
      makerName: null,
      inspection: true,
      since: times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null,
    });
  }
  // Oldest first; unknown times last; stable by job and unit.
  return rows.sort(
    (a, b) =>
      (a.waitingSince ?? "9").localeCompare(b.waitingSince ?? "9") ||
      a.jobNumber.localeCompare(b.jobNumber) ||
      (a.serialNo ?? "").localeCompare(b.serialNo ?? "", undefined, { numeric: true }) ||
      a.key.localeCompare(b.key),
  );
}

async function buildHolds(tx: Tx, s: Scope, now: Date): Promise<HoldRow[]> {
  const org = await tx.organization.findUnique({ where: { id: s.tenantId }, select: { code: true } });
  const items = await tx.qcpItem.findMany({
    where: {
      tenantId: s.tenantId,
      partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
      processLinks: {
        some: { jobProcess: { job: { status: { in: ["ACTIVE", "ON_HOLD"] }, ...(s.jobId ? { id: s.jobId } : {}) } } },
      },
    },
    select: {
      id: true,
      srNo: true,
      activity: true,
      partyCodes: {
        select: {
          qcpCode: { select: { code: true, blocksCompletion: true, requiresCall: true } },
          inspectionParty: { select: { code: true, name: true } },
        },
      },
      processLinks: {
        select: { jobProcess: { select: { id: true, seq: true, jobId: true, workOrderStages: true, job: { select: { jobNumber: true } } } } },
        orderBy: { jobProcess: { seq: "asc" } },
        take: 1,
      },
    },
  });
  if (items.length === 0) return [];

  const jobIds = [...new Set(items.map((i) => i.processLinks[0]?.jobProcess.jobId).filter((x): x is number => x != null))];
  const units = await tx.unit.findMany({
    where: { equipment: { jobId: { in: jobIds } }, ...(s.unitId ? { id: s.unitId } : {}) },
    select: { id: true, serialNo: true, equipment: { select: { jobId: true } } },
  });
  if (units.length === 0) return [];
  const unitsByJob = new Map<number, typeof units>();
  for (const u of units) (unitsByJob.get(u.equipment.jobId) ?? unitsByJob.set(u.equipment.jobId, []).get(u.equipment.jobId)!).push(u);

  const unitIds = units.map((u) => u.id);
  const itemIds = items.map((i) => i.id);
  const execs = await tx.qcpExecution.findMany({
    where: { unitId: { in: unitIds }, qcpItemId: { in: itemIds } },
    orderBy: [{ qcpItemId: "asc" }, { unitId: "asc" }, { attemptNo: "desc" }],
    distinct: ["qcpItemId", "unitId"],
    select: { qcpItemId: true, unitId: true, result: true, waiverApprovedBy: true, recordedAt: true },
  });
  const latest = new Map<string, LatestAttempt>(execs.map((e) => [`${e.qcpItemId}:${e.unitId}`, e]));

  const linkedProcessIds = [...new Set(items.map((i) => i.processLinks[0]?.jobProcess.id).filter((x): x is number => x != null))];
  const plans = await tx.processPlan.findMany({
    where: { unitId: { in: unitIds }, jobProcessId: { in: linkedProcessIds }, scheduleRun: { isCurrent: true } },
    select: { jobProcessId: true, unitId: true, plannedStart: true, status: true },
  });
  const planByKey = new Map(plans.map((p) => [`${p.jobProcessId}:${p.unitId}`, p]));

  const rows: HoldRow[] = [];
  for (const item of items) {
    const jp = item.processLinks[0]?.jobProcess;
    if (!jp) continue;
    const blocking = item.partyCodes.filter((pc) => pc.qcpCode.blocksCompletion);
    const top = [...blocking].sort((a, b) => classRank(a.qcpCode.code) - classRank(b.qcpCode.code))[0]!;
    const requiresCall = blocking.some((pc) => pc.qcpCode.requiresCall);
    const external = blocking.some((pc) => pc.inspectionParty.code !== org?.code);
    const parties = [...new Set(blocking.map((pc) => pc.inspectionParty.name ?? pc.inspectionParty.code))].join(", ");
    for (const u of unitsByJob.get(jp.jobId) ?? []) {
      const attempt = latest.get(`${item.id}:${u.id}`) ?? null;
      const status = resolveHoldPointStatus(attempt, requiresCall);
      if (status == null) continue; // cleared
      const plan = planByKey.get(`${jp.id}:${u.id}`);
      if (!holdIsReached(attempt, plan, now)) continue; // upcoming, not a hold
      rows.push({
        key: `${item.id}:${u.id}`,
        qcpItemId: item.id,
        jobId: jp.jobId,
        jobNumber: jp.job.jobNumber,
        unitId: u.id,
        serialNo: u.serialNo,
        srNo: item.srNo,
        activity: item.activity,
        classCode: top.qcpCode.code,
        parties,
        external,
        testPoint: isTestPoint(item.activity),
        status,
        ageDays: ageDaysOf(attempt ? attempt.recordedAt : (plan?.plannedStart ?? null), now),
        waiverPending: status === "WAIVER_PENDING",
      });
    }
  }
  return rows.sort(compareHolds);
}

async function buildNcrs(tx: Tx, s: Scope, now: Date): Promise<NcrQueueRow[]> {
  const rows = await tx.ncr.findMany({
    where: { status: { not: "CLOSED" }, ...ncrTenantScope(s.tenantId), ...(s.jobId ? { jobId: s.jobId } : {}) },
    select: {
      id: true,
      status: true,
      ruleCode: true,
      raisedAt: true,
      raisedByUser: { select: { name: true } },
      disposition: true,
      concessionApprovedById: true,
      componentOperationRejection: {
        select: {
          detail: true,
          rejectedAt: true,
          rejector: { select: { name: true } },
          category: { select: { name: true } },
          componentOperation: {
            select: {
              operation: { select: { name: true } },
              component: { select: { tag: true, unitId: true, unit: { select: { serialNo: true } }, equipment: { select: { jobId: true, job: { select: { jobNumber: true } } } } } },
            },
          },
        },
      },
      assemblyStepRejection: {
        select: {
          detail: true,
          rejectedAt: true,
          rejector: { select: { name: true } },
          category: { select: { name: true } },
          assemblyStep: {
            select: {
              templateStep: { select: { activity: true } },
              unit: { select: { id: true, serialNo: true, equipment: { select: { jobId: true, job: { select: { jobNumber: true } } } } } },
            },
          },
        },
      },
      targetComponentOperation: {
        select: {
          operation: { select: { name: true } },
          component: { select: { tag: true, unitId: true, unit: { select: { serialNo: true } }, equipment: { select: { jobId: true, job: { select: { jobNumber: true } } } } } },
        },
      },
      targetAssemblyStep: {
        select: {
          templateStep: { select: { activity: true } },
          unit: { select: { id: true, serialNo: true, equipment: { select: { jobId: true, job: { select: { jobNumber: true } } } } } },
        },
      },
    },
  });
  const RULE = { H5: "H5 · welding after final PWHT", H6: "H6 · welding after hydro" } as const;
  const out: NcrQueueRow[] = [];
  for (const n of rows) {
    const cor = n.componentOperationRejection;
    const asr = n.assemblyStepRejection;
    const top = n.targetComponentOperation;
    const tstep = n.targetAssemblyStep;
    let where: { jobId: number; jobNumber: string; unitId: number | null; serialNo: string | null; entityLabel: string };
    let category: string;
    let detail: string | null;
    let by: string;
    let at: Date;
    if (n.ruleCode && (top || tstep)) {
      where = top
        ? {
            jobId: top.component.equipment.jobId,
            jobNumber: top.component.equipment.job.jobNumber,
            unitId: top.component.unitId,
            serialNo: top.component.unit?.serialNo ?? null,
            entityLabel: `${top.component.tag} · ${top.operation.name}`,
          }
        : {
            jobId: tstep!.unit.equipment.jobId,
            jobNumber: tstep!.unit.equipment.job.jobNumber,
            unitId: tstep!.unit.id,
            serialNo: tstep!.unit.serialNo,
            entityLabel: tstep!.templateStep.activity,
          };
      category = RULE[n.ruleCode];
      detail = null;
      by = n.raisedByUser?.name ?? "—";
      at = n.raisedAt ?? now;
    } else if (cor) {
      const c = cor.componentOperation.component;
      where = {
        jobId: c.equipment.jobId,
        jobNumber: c.equipment.job.jobNumber,
        unitId: c.unitId,
        serialNo: c.unit?.serialNo ?? null,
        entityLabel: `${c.tag} · ${cor.componentOperation.operation.name}`,
      };
      category = cor.category.name;
      detail = cor.detail;
      by = cor.rejector.name;
      at = cor.rejectedAt;
    } else if (asr) {
      const st = asr.assemblyStep;
      where = {
        jobId: st.unit.equipment.jobId,
        jobNumber: st.unit.equipment.job.jobNumber,
        unitId: st.unit.id,
        serialNo: st.unit.serialNo,
        entityLabel: st.templateStep.activity,
      };
      category = asr.category.name;
      detail = asr.detail;
      by = asr.rejector.name;
      at = asr.rejectedAt;
    } else {
      continue; // an NCR with no resolvable source cannot be placed on a job
    }
    if (s.unitId && where.unitId !== s.unitId) continue;
    out.push({
      ncrId: n.id,
      status: n.status as NcrQueueRow["status"],
      jobId: where.jobId,
      jobNumber: where.jobNumber,
      unitId: where.unitId,
      serialNo: where.serialNo,
      entityLabel: where.entityLabel,
      categoryName: category,
      detail,
      raisedByName: by,
      raisedAt: at.toISOString(),
      ageDays: ageDaysOf(at, now),
      awaitingRatification: n.ruleCode != null && n.disposition === "CONCESSION" && n.concessionApprovedById != null,
      concessionBy: n.concessionApprovedById,
      ruleNcr: n.ruleCode != null,
    });
  }
  return out.sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || a.ncrId - b.ncrId);
}

/** Just the Ready count, for the nav badge (runs on every page load, so not all three lists). */
export async function loadQcReadyCount(actor: Actor): Promise<number> {
  if (!resolveQcAccess(actor).view) return 0;
  return withTenant(actor.tenantId, async (tx) => (await buildReady(tx, { tenantId: actor.tenantId, jobId: null, unitId: null }, new Date())).length);
}

/** The three counts the tabs and every link into /qc show, from the same builders as the lists. */
export async function loadQcCounts(actor: Actor, scope: { jobId?: number | null; unitId?: number | null } = {}): Promise<QcCounts> {
  if (!resolveQcAccess(actor).view) return { ready: 0, holds: 0, ncrs: 0 };
  const s: Scope = { tenantId: actor.tenantId, jobId: scope.jobId ?? null, unitId: scope.unitId ?? null };
  return withTenant(actor.tenantId, async (tx) => {
    const now = new Date();
    const [ready, holds, ncrs] = await Promise.all([buildReady(tx, s, now), buildHolds(tx, s, now), buildNcrs(tx, s, now)]);
    return { ready: ready.length, holds: holds.length, ncrs: ncrs.length };
  });
}

/**
 * The open holds and NCRs themselves, whole and unpaged, from the same builders as the tabs and
 * `loadQcCounts` (so a count built from them equals the tab's). For the Portfolio's exceptions.
 */
export async function loadQcLists(actor: Actor): Promise<{ holds: HoldRow[]; ncrs: NcrQueueRow[] }> {
  if (!resolveQcAccess(actor).view) return { holds: [], ncrs: [] };
  const s: Scope = { tenantId: actor.tenantId, jobId: null, unitId: null };
  return withTenant(actor.tenantId, async (tx) => {
    const now = new Date();
    const [holds, ncrs] = await Promise.all([buildHolds(tx, s, now), buildNcrs(tx, s, now)]);
    return { holds, ncrs };
  });
}

export async function loadQcQueue(actor: Actor, query: QcQuery): Promise<QcQueueView> {
  const access = resolveQcAccess(actor);
  const empty: QcQueueView = {
    access,
    query,
    counts: { ready: 0, holds: 0, ncrs: 0 },
    jobs: [],
    unitSerial: null,
    total: 0,
    page: 1,
    pages: 1,
    ready: [],
    holds: [],
    ncrs: [],
  };
  if (!access.view) return empty;

  const s: Scope = { tenantId: actor.tenantId, jobId: query.jobId, unitId: query.unitId };
  return withTenant(actor.tenantId, async (tx) => {
    const now = new Date();
    const [ready, holds, ncrs, jobs, unit] = await Promise.all([
      buildReady(tx, s, now),
      buildHolds(tx, s, now),
      buildNcrs(tx, s, now),
      tx.job.findMany({
        where: { tenantId: actor.tenantId, status: { in: ["ACTIVE", "ON_HOLD"] } },
        orderBy: { jobNumber: "asc" },
        select: { id: true, jobNumber: true },
      }),
      query.unitId
        ? tx.unit.findFirst({ where: { id: query.unitId, equipment: { job: { tenantId: actor.tenantId } } }, select: { serialNo: true } })
        : Promise.resolve(null),
    ]);
    const counts = { ready: ready.length, holds: holds.length, ncrs: ncrs.length };
    const base = { ...empty, counts, jobs, unitSerial: unit?.serialNo ?? null };
    if (query.tab === "ready") {
      const p = pageOf(ready, query.page);
      return { ...base, total: p.total, page: p.page, pages: p.pages, ready: groupByJobUnit(p.rows) };
    }
    if (query.tab === "holds") {
      const p = pageOf(holds, query.page);
      return { ...base, total: p.total, page: p.page, pages: p.pages, holds: groupByJobUnit(p.rows) };
    }
    const p = pageOf(ncrs, query.page);
    return { ...base, total: p.total, page: p.page, pages: p.pages, ncrs: groupByJobUnit(p.rows) };
  });
}
