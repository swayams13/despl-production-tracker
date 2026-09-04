import { withTenant } from "@/lib/db";
import { assertClientScope, hasRole, ROLES, type Actor } from "@/lib/authz";
import { computeCpm, workingDaysBetween } from "@/lib/schedule";
import { loadJobSpine, getCurrentScheduleRun, computeOrRefuse } from "./_shared";
import { prioritize, type PlanState, type RankedPlan } from "./prioritizer";
import type { Department, DelayCategoryRef, ProcessPlan } from "@/generated/prisma/client";
import { isOnTime, istCalendarDayMarker } from "@/lib/shared/business-day";

/**
 * The current run's per-department prioritized view — the shared read behind
 * the workspace page (Task 10) and later QC/delay/dashboard tasks. Computes
 * CPM float once from the job spine, then hands ProcessPlan rows + float +
 * process names to the pure `prioritize` ranker.
 */
export interface PrioritizedJob {
  runId: number;
  rankedByDept: Map<number, RankedPlan[]>;
  departments: Department[];
  processNameById: Map<number, string>;
  delayCategories: DelayCategoryRef[];
}

export async function loadPrioritizedJob(actor: Actor, jobId: number): Promise<PrioritizedJob | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    // Job-grain key: per-unit plans live under the null-equipment run.
    const run = await getCurrentScheduleRun(tx, jobId, null);
    if (!run) return null;

    const spine = await loadJobSpine(tx, jobId);
    // Single-job read: a malformed spine surfaces as an explainable refusal
    // rather than a bare-Error 500 (audit 0.10).
    const cpm = computeOrRefuse(() => computeCpm(spine.processes, spine.edges));
    const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
    const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));

    const rankedByDept = prioritize({
      plans: run.processPlans,
      edges: spine.edges,
      floatByProcessId,
      processNameById,
      today: new Date(),
    });

    const departments = await tx.department.findMany();
    const delayCategories = await tx.delayCategoryRef.findMany({ where: { active: true } });
    return { runId: run.id, rankedByDept, departments, processNameById, delayCategories };
  });
}

export interface OpenHoldPoint {
  qcpItemId: number;
  activity: string;
  unitId: number;
  serialNo: string;
  /** QcpItem.srNo — the checklist reference (e.g. "3.1"), for display. */
  srNo: string;
  /** The blocking party code (H/W/R/RW/…) — the mockup's class glyph. */
  classCode: string;
  /** true when the blocking code requires a TPI call and none has been attempted yet. */
  awaitingTpi: boolean;
  /** Human status for the row: "Awaiting TPI" · "Pending" · "QC review" · "Reinspect". */
  status: string;
  /** Calendar days since the last attempt was recorded, or since the linked
   * process's planned start if never attempted — see `loadOpenHoldPoints`. */
  ageDays: number;
}

/**
 * Open blocking hold points across the job's units — the same
 * blocking/latest-attempt logic as `assertNoOpenHoldPoint` in `_shared.ts`,
 * but fanned out over every (blocking QcpItem × job unit) pair instead of a
 * single process/unit, so the QC "clear a hold point" list agrees with what
 * the gate will actually refuse.
 */
export async function loadOpenHoldPoints(actor: Actor, jobId: number): Promise<OpenHoldPoint[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return [];
    assertClientScope(actor, job.clientId);

    const units = await tx.unit.findMany({
      where: { equipment: { jobId } },
      select: { id: true, serialNo: true },
    });
    if (units.length === 0) return [];

    const blockingItems = await tx.qcpItem.findMany({
      where: {
        processLinks: { some: { jobProcess: { jobId } } },
        partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
      },
      select: {
        id: true,
        srNo: true,
        activity: true,
        partyCodes: { where: { qcpCode: { blocksCompletion: true } }, select: { qcpCode: { select: { code: true, requiresCall: true } } } },
        // Earliest-by-seq linked process, for the "no attempt yet" age reference.
        processLinks: {
          select: { jobProcess: { select: { id: true, seq: true } } },
          orderBy: { jobProcess: { seq: "asc" } },
          take: 1,
        },
      },
    });
    if (blockingItems.length === 0) return [];

    const itemIds = blockingItems.map((i) => i.id);
    const unitIds = units.map((u) => u.id);
    const execs = await tx.qcpExecution.findMany({
      where: { unitId: { in: unitIds }, qcpItemId: { in: itemIds } },
      orderBy: { attemptNo: "desc" },
      select: { qcpItemId: true, unitId: true, result: true, recordedAt: true },
    });

    // Latest attempt per (item, unit) — mirrors assertNoOpenHoldPoint's per-item map.
    const latestByKey = new Map<string, { result: string; recordedAt: Date }>();
    for (const e of execs) {
      const k = `${e.qcpItemId}:${e.unitId}`;
      if (!latestByKey.has(k)) latestByKey.set(k, { result: e.result, recordedAt: e.recordedAt });
    }

    // Reference plannedStart per (item, unit) — from the item's earliest-linked
    // process's current-run plan, used as the age reference when no attempt exists.
    const linkedProcessId = new Map(blockingItems.map((i) => [i.id, i.processLinks[0]?.jobProcess.id ?? null]));
    const plans = await tx.processPlan.findMany({
      where: { unitId: { in: unitIds }, jobProcessId: { in: [...linkedProcessId.values()].filter((x): x is number => x != null) }, scheduleRun: { isCurrent: true } },
      select: { jobProcessId: true, unitId: true, plannedStart: true },
    });
    const plannedStartByKey = new Map(plans.map((p) => [`${p.jobProcessId}:${p.unitId}`, p.plannedStart]));

    const itemById = new Map(blockingItems.map((i) => [i.id, i]));
    const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));
    const now = new Date();

    const open: OpenHoldPoint[] = [];
    for (const itemId of itemIds) {
      const item = itemById.get(itemId)!;
      const blockingCode = item.partyCodes[0]?.qcpCode;
      const classCode = blockingCode?.code ?? "?";
      const requiresCall = blockingCode?.requiresCall ?? false;
      const jpId = linkedProcessId.get(itemId);

      for (const unitId of unitIds) {
        const attempt = latestByKey.get(`${itemId}:${unitId}`);
        const r = attempt?.result;
        if (r === "ACCEPTED" || r === "NA") continue; // cleared

        let status: string;
        let ageRef: Date | null;
        if (!attempt) {
          status = requiresCall ? "Awaiting TPI" : "Pending";
          ageRef = jpId != null ? (plannedStartByKey.get(`${jpId}:${unitId}`) ?? null) : null;
        } else if (r === "REJECTED") {
          status = "Reinspect";
          ageRef = attempt.recordedAt;
        } else {
          status = "QC review"; // PENDING attempt already recorded, awaiting decision
          ageRef = attempt.recordedAt;
        }
        const ageDays = ageRef ? Math.max(0, Math.floor((now.getTime() - ageRef.getTime()) / 864e5)) : 0;

        open.push({
          qcpItemId: itemId,
          activity: item.activity,
          unitId,
          serialNo: serialByUnit.get(unitId)!,
          srNo: item.srNo,
          classCode,
          awaitingTpi: status === "Awaiting TPI",
          status,
          ageDays,
        });
      }
    }
    return open;
  });
}

// ── Workspace view (§4.4) — per-process cards + QC queue ─────────────────

export interface WsUnitRow {
  planId: number;
  serialNo: string;
  plannedFinish: string | null;
  daysOverdue: number;
  overdue: boolean;
  state: PlanState;
  reasonText: string;
  criticalPath: boolean;
  /** N2 — open (non-CLOSED) Ncrs whose rejected ComponentOperation/AssemblyStep
   * belongs to this unit (via Component.unitId or AssemblyStep.unitId). */
  openNcrCount: number;
}
export interface WsCard {
  jobProcessId: number;
  processName: string;
  stageLabel: string;
  deptName: string;
  overdueCount: number;
  criticalPath: boolean;
  units: WsUnitRow[];
}
export interface WsQcRow {
  planId: number;
  processName: string;
  serialNo: string;
  submittedBy: string | null;
}
export interface WorkspaceView {
  jobId: number;
  jobNumber: string;
  isQc: boolean;
  counts: { overdue: number; dueToday: number; awaitingQc: number };
  cards: WsCard[];
  qcQueue: WsQcRow[];
  holdPoints: OpenHoldPoint[];
  delayCategories: { id: number; name: string }[];
  filter: { label: string } | null;
}

export interface WorkspaceFilter {
  dept?: string; // department id or name (dashboard matrix deep-link)
  status?: string; // a display state: overdue | hold | submitted | progress | ready | idle
  sort?: string; // critical (default) | overdue | due
}

/**
 * B7: no more universal "of 25" — the work-order stage count is per family
 * (`WorkOrderStage`), not a fixed constant, so this just names the stage
 * number(s) a process rolls up into without asserting a family-wide total.
 * Exported so myday.read.ts's cross-job row labels reuse this instead of a
 * second implementation.
 */
export function stageLabel(workOrderStages: number[]): string {
  if (workOrderStages.length === 0) return "—";
  const lo = Math.min(...workOrderStages);
  const hi = Math.max(...workOrderStages);
  return lo === hi ? `Stage ${lo}` : `Stages ${lo}–${hi}`;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

/** Map a RankedPlan to the display state used by the row action button. */
function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 864e5));
}

/**
 * The `/workspace` view model (§4.4): the actor's scoped plans grouped into
 * per-process cards (rows = units), a QC verification queue (SUBMITTED, all
 * departments — QC verifies cross-dept), open hold points, and the header
 * counts. Reuses the same spine/CPM/prioritize pipeline as `loadPrioritizedJob`
 * / `loadJobKpis`. Filters (dashboard deep-links) narrow the plans before
 * grouping; the returned `filter.label` drives the dismissible chip.
 */
export async function loadWorkspaceView(
  actor: Actor,
  jobId: number,
  filter: WorkspaceFilter = {},
): Promise<WorkspaceView | null> {
  const holdPoints = hasRole(actor, ROLES.QC) ? await loadOpenHoldPoints(actor, jobId) : [];

  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true, jobNumber: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const run = await getCurrentScheduleRun(tx, jobId, null);
    if (!run) return null;

    const spine = await loadJobSpine(tx, jobId);
    // Single-job read: a malformed spine surfaces as an explainable refusal
    // rather than a bare-Error 500 (audit 0.10).
    const cpm = computeOrRefuse(() => computeCpm(spine.processes, spine.edges));
    const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
    const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));
    const procMeta = new Map(
      spine.rawProcesses.map((p) => [p.id, { name: p.name, stageLabel: stageLabel(p.workOrderStages), deptId: p.departmentId }]),
    );

    const rankedByDept = prioritize({
      plans: run.processPlans,
      edges: spine.edges,
      floatByProcessId,
      processNameById,
      today: new Date(),
    });

    const departments = await tx.department.findMany();
    const deptNameById = new Map(departments.map((d) => [d.id, d.name]));

    const seesAll = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.MANAGEMENT);
    const scopedDeptIds = seesAll ? new Set(departments.map((d) => d.id)) : new Set(actor.departmentIds);

    const units = await tx.unit.findMany({ where: { equipment: { jobId } }, select: { id: true, serialNo: true } });
    const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));

    // N2 — open Ncr count per unit. ComponentOperation only attributes to a
    // unit when its Component is serial-scoped (Component.unitId set);
    // equipment-grain components (unitId null) have no single unit row to
    // attach to and are skipped here, same as everywhere else per-unit rows
    // are built from equipment-grain data. AssemblyStep is always unit-scoped.
    const openNcrRows = await tx.ncr.findMany({
      where: {
        status: { not: "CLOSED" },
        OR: [
          { componentOperationRejection: { componentOperation: { component: { unitId: { not: null }, equipment: { jobId } } } } },
          { assemblyStepRejection: { assemblyStep: { unit: { equipment: { jobId } } } } },
        ],
      },
      select: {
        componentOperationRejection: { select: { componentOperation: { select: { component: { select: { unitId: true } } } } } },
        assemblyStepRejection: { select: { assemblyStep: { select: { unitId: true } } } },
      },
    });
    const openNcrCountByUnit = new Map<number, number>();
    for (const row of openNcrRows) {
      const unitId =
        row.componentOperationRejection?.componentOperation.component.unitId ?? row.assemblyStepRejection?.assemblyStep.unitId;
      if (unitId == null) continue;
      openNcrCountByUnit.set(unitId, (openNcrCountByUnit.get(unitId) ?? 0) + 1);
    }

    const today = new Date();

    // Filter predicate over a ranked plan (dashboard deep-link narrowing).
    const deptFilterId = resolveDeptFilter(filter.dept, deptNameById);
    const statusFilter = filter.status?.toLowerCase();
    const matchesFilter = (r: RankedPlan, deptId: number): boolean => {
      if (deptFilterId != null && deptId !== deptFilterId) return false;
      // "rework" reuses the same ?status= convention but isn't a PlanState —
      // it deep-links to units carrying an open Ncr instead.
      if (statusFilter === "rework") return (openNcrCountByUnit.get(r.plan.unitId ?? -1) ?? 0) > 0;
      if (statusFilter) return displayState(r) === statusFilter;
      return true;
    };

    // Header counts over the actor's whole scope (unfiltered).
    let overdue = 0;
    let dueToday = 0;
    let awaitingQc = 0;
    const scopedRanked: RankedPlan[] = [];
    for (const [deptId, rows] of rankedByDept) {
      if (!scopedDeptIds.has(deptId)) continue;
      for (const r of rows) {
        scopedRanked.push(r);
        if (r.overdue) overdue++;
        else if (r.plan.plannedFinish && r.state !== "DONE" && sameCalendarDay(r.plan.plannedFinish, today)) dueToday++;
        if (r.state === "SUBMITTED") awaitingQc++;
      }
    }

    // Per-process cards: scoped, actionable (not DONE, not SUBMITTED), filtered.
    const cardByProcess = new Map<number, WsCard>();
    for (const r of scopedRanked) {
      if (r.state === "DONE" || r.state === "SUBMITTED") continue;
      const meta = procMeta.get(r.plan.jobProcessId);
      if (!meta) continue;
      if (!matchesFilter(r, meta.deptId)) continue;

      let card = cardByProcess.get(r.plan.jobProcessId);
      if (!card) {
        card = {
          jobProcessId: r.plan.jobProcessId,
          processName: meta.name,
          stageLabel: meta.stageLabel,
          deptName: deptNameById.get(meta.deptId) ?? `#${meta.deptId}`,
          overdueCount: 0,
          criticalPath: false,
          units: [],
        };
        cardByProcess.set(r.plan.jobProcessId, card);
      }
      const daysOverdue = r.overdue && r.plan.plannedFinish ? daysBetween(r.plan.plannedFinish, today) : 0;
      card.units.push({
        planId: r.plan.id,
        serialNo: r.plan.unitId != null ? serialByUnit.get(r.plan.unitId) ?? `#${r.plan.unitId}` : "—",
        plannedFinish: r.plan.plannedFinish ? r.plan.plannedFinish.toISOString() : null,
        daysOverdue,
        overdue: r.overdue,
        state: r.state,
        reasonText: r.reasonText,
        criticalPath: r.criticalPath,
        openNcrCount: openNcrCountByUnit.get(r.plan.unitId ?? -1) ?? 0,
      });
      if (r.overdue) card.overdueCount++;
      if (r.criticalPath) card.criticalPath = true;
    }
    // Units within a card by serial; cards by the chosen sort (§4.4).
    const cards = Array.from(cardByProcess.values());
    for (const c of cards) c.units.sort((a, b) => a.serialNo.localeCompare(b.serialNo));
    sortCards(cards, filter.sort);

    // QC queue: SUBMITTED plans across ALL departments (QC verifies cross-dept).
    const isQc = hasRole(actor, ROLES.QC);
    const qcQueue: WsQcRow[] = [];
    if (isQc) {
      const submitted = Array.from(rankedByDept.values()).flat().filter((r) => r.state === "SUBMITTED");
      const submitterIds = [...new Set(submitted.map((r) => r.plan.submittedBy).filter((x): x is number => x != null))];
      const submitters = submitterIds.length
        ? await tx.user.findMany({ where: { id: { in: submitterIds } }, select: { id: true, name: true } })
        : [];
      const nameById = new Map(submitters.map((u) => [u.id, u.name]));
      for (const r of submitted) {
        qcQueue.push({
          planId: r.plan.id,
          processName: processNameById.get(r.plan.jobProcessId) ?? `#${r.plan.jobProcessId}`,
          serialNo: r.plan.unitId != null ? serialByUnit.get(r.plan.unitId) ?? `#${r.plan.unitId}` : "—",
          submittedBy: r.plan.submittedBy != null ? nameById.get(r.plan.submittedBy) ?? null : null,
        });
      }
    }

    const delayCategories = (await tx.delayCategoryRef.findMany({ where: { active: true }, select: { id: true, name: true } }));

    const filterLabel = buildFilterLabel(deptFilterId, deptNameById, statusFilter);

    return {
      jobId,
      jobNumber: job.jobNumber,
      isQc,
      counts: { overdue, dueToday, awaitingQc },
      cards,
      qcQueue,
      holdPoints,
      delayCategories,
      filter: filterLabel ? { label: filterLabel } : null,
    };
  });
}

/** Order the worklist cards by the chosen sort. Default: overdue-then-critical. */
function sortCards(cards: WsCard[], sort?: string): void {
  if (sort === "overdue") {
    const maxOverdue = (c: WsCard) => Math.max(0, ...c.units.map((u) => u.daysOverdue));
    cards.sort((a, b) => maxOverdue(b) - maxOverdue(a) || a.processName.localeCompare(b.processName));
    return;
  }
  if (sort === "due") {
    const earliest = (c: WsCard) => Math.min(...c.units.map((u) => (u.plannedFinish ? new Date(u.plannedFinish).getTime() : Infinity)));
    cards.sort((a, b) => earliest(a) - earliest(b) || a.processName.localeCompare(b.processName));
    return;
  }
  // critical (default): has-overdue first, then critical path, then name.
  cards.sort(
    (a, b) =>
      Number(b.overdueCount > 0) - Number(a.overdueCount > 0) ||
      Number(b.criticalPath) - Number(a.criticalPath) ||
      a.processName.localeCompare(b.processName),
  );
}

/** The §11.2-style display state of a ranked plan, for status filtering. */
function displayState(r: RankedPlan): string {
  if (r.state === "DONE") return "complete";
  if (r.state === "ON_HOLD") return "hold";
  if (r.overdue) return "overdue";
  if (r.state === "SUBMITTED") return "submitted";
  if (r.state === "IN_PROGRESS" || r.state === "READY") return "progress";
  return "idle";
}

function resolveDeptFilter(dept: string | undefined, deptNameById: Map<number, string>): number | null {
  if (!dept) return null;
  if (/^\d+$/.test(dept)) return Number(dept);
  const hit = [...deptNameById].find(([, name]) => name.toLowerCase() === dept.toLowerCase());
  return hit ? hit[0] : null;
}

function buildFilterLabel(deptId: number | null, deptNameById: Map<number, string>, status?: string): string | null {
  const parts: string[] = [];
  if (deptId != null) parts.push(deptNameById.get(deptId) ?? `Dept #${deptId}`);
  if (status) parts.push(status[0].toUpperCase() + status.slice(1));
  return parts.length ? parts.join(" · ") : null;
}

// ── Management KPI dashboard (Task 13) ───────────────────────────────────

const PLAN_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "COMPLETE", "ON_HOLD"] as const;

function emptyStatusCounts(): Record<string, number> {
  return Object.fromEntries(PLAN_STATUSES.map((s) => [s, 0]));
}

/** Cumulative planned-vs-actual counts, one point per week from the run's
 * project start to the later of (latest plannedFinish, today). `actual` is
 * null for weeks still in the future — no actual data to report yet. */
function buildSCurve(
  plans: ProcessPlan[],
  projectStartDate: Date,
): { label: string; planned: number; actual: number | null }[] {
  const finishDates = plans.map((p) => p.plannedFinish).filter((d): d is Date => d != null);
  if (finishDates.length === 0) return [];

  const today = new Date();
  const maxFinish = new Date(Math.max(...finishDates.map((d) => d.getTime())));
  const horizonEnd = maxFinish > today ? maxFinish : today;

  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const totalWeeks = Math.max(1, Math.ceil((horizonEnd.getTime() - projectStartDate.getTime()) / msPerWeek));

  const points: { label: string; planned: number; actual: number | null }[] = [];
  for (let w = 1; w <= totalWeeks; w++) {
    const weekEnd = new Date(projectStartDate.getTime() + w * msPerWeek);
    const planned = plans.filter((p) => p.plannedFinish != null && p.plannedFinish <= weekEnd).length;
    const actual =
      weekEnd <= today
        ? plans.filter((p) => p.status === "COMPLETE" && p.actualFinish != null && p.actualFinish <= weekEnd).length
        : null;
    points.push({ label: `W${w}`, planned, actual });
  }
  return points;
}

export interface JobKpis {
  jobNumber: string;
  equipmentName: string | null;
  designCode: string | null;
  unitCount: number;
  /** Contractual dispatch date (null for jobs DESPL hasn't confirmed yet — e.g. the DESPL-320 pilot). */
  committedDeliveryDate: string | null;
  /** The schedule engine's own computed makespan: max(plannedFinish) across the
   * current run's plans. Not a live re-forecast from actual progress — that's
   * Phase 2 (would need to re-run CPM from today using remaining durations). */
  forecastDispatch: string | null;
  /** forecastDispatch − committedDeliveryDate, calendar days. Null when there's no contractual date to compare against. */
  forecastVarianceDays: number | null;
  totalPlans: number;
  percentComplete: number;
  byState: Record<string, number>;
  overdue: number;
  openHoldPoints: number;
  delaysByCategory: { category: string; count: number }[];
  deptMatrix: { departmentId: number; department: string; counts: Record<string, number>; onTimePct: number | null }[];
  sCurve: { label: string; planned: number; actual: number | null }[];
  stats: {
    /** (submitted-ever − rejected-ever) ÷ submitted-ever, over the job's plans. Null if nothing's been submitted yet. */
    firstPassYieldPct: number | null;
    /** Avg (actual working days − standard working days) over COMPLETE plans with both known. Positive = running long. */
    avgCycleVsStandardDays: number | null;
    stagesVerified7d: number;
    stagesVerified7dDelta: number;
    /** Overdue plans with zero DelayReason filed yet (invariant #7 still owed). */
    reasonsPending: number;
    activeUsersToday: number;
    activeUsersTotal: number;
  };
  criticalPathBlocking: { planId: number; processName: string; departmentId: number; deptName: string; serialNo: string; daysOverdue: number }[];
  throughputByWeek: { label: string; count: number }[];
  /** Plans/week needed to hit the contractual date from today. Null with no committedDeliveryDate. */
  throughputTargetPerWeek: number | null;
  cycleTimeOffenders: { processName: string; deptName: string; standardDays: number; avgActualDays: number; deltaDays: number }[];
  overdueAgingByDept: { departmentId: number; department: string; d1to3: number; d3to7: number; d7plus: number }[];
  holdPointsTop: OpenHoldPoint[];
  oldestHoldAgeDays: number | null;
  awaitingTpiCount: number;
}

/** Bucket a job's ProcessVerified events into weekly counts, oldest → newest, ending this week. */
function buildThroughput(verifiedAt: Date[], weeks: number, now: Date): { label: string; count: number }[] {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const points: { label: string; count: number }[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const weekEnd = new Date(now.getTime() - w * msPerWeek);
    const weekStart = new Date(weekEnd.getTime() - msPerWeek);
    const count = verifiedAt.filter((d) => d > weekStart && d <= weekEnd).length;
    points.push({ label: `W-${w}`, count });
  }
  return points;
}

/**
 * Cross-department KPI aggregate behind `/dashboard` (§4.2) — MD/CEO/SJ's
 * "leadership sees the workflow working" screen. Reuses the same spine/CPM/
 * prioritize pipeline `loadPrioritizedJob` runs (one tx, no new engine work),
 * then folds the ranked plans + raw ProcessPlan rows + delay reasons + the
 * domain-event stream into plain, serialisable primitives.
 */
export async function loadJobKpis(actor: Actor, jobId: number): Promise<JobKpis | null> {
  // Its own tx (same as the workspace page's QC section) — the small race
  // window against the transaction below is immaterial for a read-only KPI
  // dashboard.
  const openHoldPoints = await loadOpenHoldPoints(actor, jobId);

  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: jobId },
      select: { clientId: true, jobNumber: true, designCode: true, committedDeliveryDate: true },
    });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const run = await getCurrentScheduleRun(tx, jobId, null);
    if (!run) return null;

    const spine = await loadJobSpine(tx, jobId);
    // Single-job read: a malformed spine surfaces as an explainable refusal
    // rather than a bare-Error 500 (audit 0.10).
    const cpm = computeOrRefuse(() => computeCpm(spine.processes, spine.edges));
    const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
    const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));
    const durationMaxById = new Map(spine.rawProcesses.map((p) => [p.id, p.durationMaxDays]));

    const rankedByDept = prioritize({
      plans: run.processPlans,
      edges: spine.edges,
      floatByProcessId,
      processNameById,
      today: new Date(),
    });

    const byState: Record<string, number> = {};
    let overdue = 0;
    for (const r of rankedByDept.values()) {
      for (const p of r) {
        byState[p.state] = (byState[p.state] ?? 0) + 1;
        if (p.overdue) overdue++;
      }
    }

    const totalPlans = run.processPlans.length;
    const completeCount = run.processPlans.filter((p) => p.status === "COMPLETE").length;
    // Phase 3, R1/R3: same duration-weighted, mapped-ops-aware view every
    // percent-complete surface reads — never re-derived from completeCount.
    const percentPlanIds = run.processPlans.map((p) => p.id);
    const percentRows = percentPlanIds.length
      ? await tx.$queryRaw<{ percent: string | number }[]>`
          SELECT sum(percent * weight) / sum(weight) AS percent
          FROM v_process_plan_percent
          WHERE process_plan_id = ANY(${percentPlanIds}::int[])
        `
      : [];
    const percentComplete = Math.round(Number(percentRows[0]?.percent ?? 0));

    const departments = await tx.department.findMany();
    const deptNameById = new Map(departments.map((d) => [d.id, d.name]));
    const matrixByDept = new Map<number, Record<string, number>>();
    const onTimeByDept = new Map<number, { onTime: number; total: number }>();
    for (const p of run.processPlans) {
      const counts = matrixByDept.get(p.ownerDepartmentId) ?? emptyStatusCounts();
      counts[p.status] = (counts[p.status] ?? 0) + 1;
      matrixByDept.set(p.ownerDepartmentId, counts);
      if (p.status === "COMPLETE" && p.actualFinish && p.plannedFinish) {
        const bucket = onTimeByDept.get(p.ownerDepartmentId) ?? { onTime: 0, total: 0 };
        bucket.total++;
        if (isOnTime(p.actualFinish, p.plannedFinish)) bucket.onTime++;
        onTimeByDept.set(p.ownerDepartmentId, bucket);
      }
    }
    const deptMatrix = Array.from(matrixByDept, ([deptId, counts]) => {
      const ot = onTimeByDept.get(deptId);
      return {
        departmentId: deptId,
        department: deptNameById.get(deptId) ?? `#${deptId}`,
        counts,
        onTimePct: ot && ot.total > 0 ? Math.round((ot.onTime / ot.total) * 100) : null,
      };
    });

    const delayRows = await tx.delayReason.findMany({
      where: { processPlan: { scheduleRunId: run.id } },
      select: { category: { select: { name: true } } },
    });
    const delayCountByCategory = new Map<string, number>();
    for (const d of delayRows) {
      delayCountByCategory.set(d.category.name, (delayCountByCategory.get(d.category.name) ?? 0) + 1);
    }
    const delaysByCategory = Array.from(delayCountByCategory, ([category, count]) => ({ category, count }));

    // ── Forecast (§4.2): the schedule engine's own computed makespan ────────
    const finishDates = run.processPlans.map((p) => p.plannedFinish).filter((d): d is Date => d != null);
    const forecastDispatch = finishDates.length ? new Date(Math.max(...finishDates.map((d) => d.getTime()))) : null;
    const forecastVarianceDays =
      forecastDispatch && job.committedDeliveryDate
        ? Math.round((forecastDispatch.getTime() - job.committedDeliveryDate.getTime()) / 864e5)
        : null;

    // ── Domain-event stream: submit/reject/verify counts for this run's plans ─
    const planIds = run.processPlans.map((p) => String(p.id));
    const eventCounts = await tx.$queryRaw<
      { verified_7d: number; verified_prior_7d: number; submitted_ever: number; rejected_ever: number }[]
    >`
      SELECT
        count(*) FILTER (WHERE type = 'ProcessVerified' AND at >= now() - interval '7 days')::int AS verified_7d,
        count(*) FILTER (WHERE type = 'ProcessVerified' AND at >= now() - interval '14 days' AND at < now() - interval '7 days')::int AS verified_prior_7d,
        count(DISTINCT aggregate_id) FILTER (WHERE type = 'ProcessSubmitted')::int AS submitted_ever,
        count(DISTINCT aggregate_id) FILTER (WHERE type = 'ProcessRejected')::int AS rejected_ever
      FROM domain_events
      WHERE aggregate_type = 'ProcessPlan' AND aggregate_id = ANY(${planIds}::text[])
    `;
    const ec = eventCounts[0];
    const submittedEver = ec?.submitted_ever ?? 0;
    const rejectedEver = ec?.rejected_ever ?? 0;
    const firstPassYieldPct = submittedEver > 0 ? Math.round(((submittedEver - rejectedEver) / submittedEver) * 100) : null;
    const stagesVerified7d = ec?.verified_7d ?? 0;
    const stagesVerified7dDelta = stagesVerified7d - (ec?.verified_prior_7d ?? 0);

    const verifiedRows = await tx.$queryRaw<{ at: Date }[]>`
      SELECT at FROM domain_events
      WHERE aggregate_type = 'ProcessPlan' AND aggregate_id = ANY(${planIds}::text[]) AND type = 'ProcessVerified'
        AND at >= now() - interval '7 weeks'
    `;
    const throughputByWeek = buildThroughput(verifiedRows.map((r) => r.at), 7, new Date());

    let throughputTargetPerWeek: number | null = null;
    if (job.committedDeliveryDate) {
      const remaining = totalPlans - completeCount;
      const weeksUntilDue = Math.max(1, Math.ceil((job.committedDeliveryDate.getTime() - Date.now()) / (7 * 864e5)));
      throughputTargetPerWeek = remaining > 0 ? Math.ceil(remaining / weeksUntilDue) : 0;
    }

    // ── Avg cycle vs standard + cycle-time offenders (§4.2 stat strip + panel) ─
    const cycleByProcess = new Map<number, number[]>(); // jobProcessId -> deltas (working days)
    for (const p of run.processPlans) {
      if (p.status !== "COMPLETE" || !p.actualStart || !p.actualFinish) continue;
      const standard = durationMaxById.get(p.jobProcessId);
      if (standard == null) continue;
      const actualDays = workingDaysBetween(p.actualStart, p.actualFinish, spine.calendar);
      const delta = actualDays - standard;
      if (!cycleByProcess.has(p.jobProcessId)) cycleByProcess.set(p.jobProcessId, []);
      cycleByProcess.get(p.jobProcessId)!.push(delta);
    }
    const allDeltas = Array.from(cycleByProcess.values()).flat();
    const avgCycleVsStandardDays = allDeltas.length
      ? Math.round((allDeltas.reduce((a, b) => a + b, 0) / allDeltas.length) * 10) / 10
      : null;

    const deptIdByProcess = new Map(spine.rawProcesses.map((p) => [p.id, p.departmentId]));
    const cycleTimeOffenders = Array.from(cycleByProcess, ([jpId, deltas]) => {
      const avgActual = deltas.reduce((a, b) => a + b, 0) / deltas.length + (durationMaxById.get(jpId) ?? 0);
      return {
        processName: processNameById.get(jpId) ?? `#${jpId}`,
        deptName: deptNameById.get(deptIdByProcess.get(jpId) ?? -1) ?? "—",
        standardDays: durationMaxById.get(jpId) ?? 0,
        avgActualDays: Math.round(avgActual * 10) / 10,
        deltaDays: Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10,
      };
    })
      .filter((o) => o.deltaDays > 0)
      .sort((a, b) => b.deltaDays - a.deltaDays)
      .slice(0, 5);

    // ── Critical path panel + overdue aging (§4.2) ───────────────────────────
    const units = await tx.unit.findMany({ where: { equipment: { jobId } }, select: { id: true, serialNo: true } });
    const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));
    const today = new Date();

    const criticalPathBlocking = Array.from(rankedByDept.values())
      .flat()
      .filter((r) => r.overdue && r.criticalPath && r.plan.plannedFinish)
      .map((r) => ({
        planId: r.plan.id,
        processName: processNameById.get(r.plan.jobProcessId) ?? `#${r.plan.jobProcessId}`,
        departmentId: r.plan.ownerDepartmentId,
        deptName: deptNameById.get(r.plan.ownerDepartmentId) ?? "—",
        serialNo: r.plan.unitId != null ? serialByUnit.get(r.plan.unitId) ?? `#${r.plan.unitId}` : "—",
        daysOverdue: Math.max(0, Math.floor((today.getTime() - r.plan.plannedFinish!.getTime()) / 864e5)),
      }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue)
      .slice(0, 5);

    const agingByDept = new Map<number, { d1to3: number; d3to7: number; d7plus: number }>();
    const overduePlanIds: number[] = [];
    for (const r of Array.from(rankedByDept.values()).flat()) {
      if (!r.overdue || !r.plan.plannedFinish) continue;
      overduePlanIds.push(r.plan.id);
      const days = Math.max(0, Math.floor((today.getTime() - r.plan.plannedFinish.getTime()) / 864e5));
      const bucket = agingByDept.get(r.plan.ownerDepartmentId) ?? { d1to3: 0, d3to7: 0, d7plus: 0 };
      if (days > 7) bucket.d7plus++;
      else if (days > 3) bucket.d3to7++;
      else bucket.d1to3++;
      agingByDept.set(r.plan.ownerDepartmentId, bucket);
    }
    const overdueAgingByDept = Array.from(agingByDept, ([deptId, b]) => ({
      departmentId: deptId,
      department: deptNameById.get(deptId) ?? `#${deptId}`,
      ...b,
    })).sort((a, b) => b.d7plus + b.d3to7 + b.d1to3 - (a.d7plus + a.d3to7 + a.d1to3));

    // ── Reasons pending (§4.2 stat strip) ────────────────────────────────────
    const reasonedPlanIds = overduePlanIds.length
      ? new Set((await tx.delayReason.findMany({ where: { processPlanId: { in: overduePlanIds } }, select: { processPlanId: true } })).map((d) => d.processPlanId))
      : new Set<number>();
    const reasonsPending = overduePlanIds.filter((id) => !reasonedPlanIds.has(id)).length;

    // ── Active users today (§4.2 stat strip) — tenant-wide, staff only ───────
    const activeUsersTotal = await tx.user.count({ where: { active: true, clientId: null } });
    const activeTodayRows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT actor_id)::int AS n FROM domain_events
      WHERE at >= date_trunc('day', now()) AND at < date_trunc('day', now()) + interval '1 day'
    `;
    const activeUsersToday = activeTodayRows[0]?.n ?? 0;

    // ── Header (equipment name, unit count) ──────────────────────────────────
    const equipment = await tx.equipment.findFirst({ where: { jobId }, orderBy: { id: "asc" }, select: { name: true } });
    const unitCount = units.length;

    return {
      jobNumber: job.jobNumber,
      equipmentName: equipment?.name ?? null,
      designCode: job.designCode,
      unitCount,
      committedDeliveryDate: job.committedDeliveryDate ? job.committedDeliveryDate.toISOString() : null,
      forecastDispatch: forecastDispatch ? forecastDispatch.toISOString() : null,
      forecastVarianceDays,
      totalPlans,
      percentComplete,
      byState,
      overdue,
      openHoldPoints: openHoldPoints.length,
      delaysByCategory,
      deptMatrix,
      sCurve: buildSCurve(run.processPlans, run.projectStartDate),
      stats: {
        firstPassYieldPct,
        avgCycleVsStandardDays,
        stagesVerified7d,
        stagesVerified7dDelta,
        reasonsPending,
        activeUsersToday,
        activeUsersTotal,
      },
      criticalPathBlocking,
      throughputByWeek,
      throughputTargetPerWeek,
      cycleTimeOffenders,
      overdueAgingByDept,
      holdPointsTop: [...openHoldPoints].sort((a, b) => b.ageDays - a.ageDays).slice(0, 5),
      oldestHoldAgeDays: openHoldPoints.length ? Math.max(...openHoldPoints.map((h) => h.ageDays)) : null,
      awaitingTpiCount: openHoldPoints.filter((h) => h.awaitingTpi).length,
    };
  });
}

/**
 * Cross-job overdue count for the sidebar "My Workspace" badge — scoped to
 * the actor's own departments (PH/admin/management see every department's
 * overdue count, matching requireDepartmentScope's own bypass rule).
 */
export async function loadMyOverdueCount(actor: Actor): Promise<number> {
  return withTenant(actor.tenantId, async (tx) => {
    const scoped = !hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.MANAGEMENT);
    if (scoped && actor.departmentIds.length === 0) return 0;
    return tx.processPlan.count({
      where: {
        status: { not: "COMPLETE" },
        plannedFinish: { lt: istCalendarDayMarker() },
        scheduleRun: { isCurrent: true },
        ...(scoped ? { ownerDepartmentId: { in: actor.departmentIds } } : {}),
      },
    });
  });
}
