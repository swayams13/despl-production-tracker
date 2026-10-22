import { routeKey, routeWhere } from "./line-route";
import type { Tx } from "@/lib/db";
import { AppError } from "@/lib/shared/errors";
import {
  drawingStateOf,
  evaluateHard,
  type FloorItem,
  type ItemStatus,
  type OpItem,
  type PlanItem,
  type StepItem,
  type UnitFacts,
  type WorkKind,
  requiredJointRef,
} from "@/lib/shared/floor-rules";
import { loadOpSeqResolver, lotQtyByUnit, openQcpItemIdsForUnit } from "./_shared";
import { activeRow } from "./active-row";

/**
 * Lean Core L1.2: the per-unit snapshot floor-rules.ts evaluates, loaded once
 * per unit (or once for the job's unit-less items) inside recordWork's
 * transaction, after the unit's floor lock is held. recordWork mutates the
 * FloorItem objects in place as it applies items, so a later item in the same
 * batch sees an earlier one's new status.
 */

/** What recordWork needs about an item beyond the rule facts. */
export interface WorkRow {
  item: FloorItem;
  unitId: number | null;
  requiresQc: boolean;
  departmentId: number | null;
  /** COALESCE(reportedStartAt, startedAt / actualStart). */
  startedAt: Date | null;
  stepKind?: "WORK" | "INSPECTION";
  /** Template step's own jointRef: the legacy "bind a weld joint before submit" rule keys off it. */
  templateJointRef?: string | null;
  weldJointId?: number | null;
  componentId?: number;
  /** COMPONENT_OP: OperationRef.requiresDftGate (a QC-free Done still needs the coats). */
  requiresDftGate?: boolean;
  /** Current drawing revision, stamped as Component.builtToRevisionId when CUTTING starts on it. */
  currentRevisionId?: number | null;
  jobProcessId?: number;
  plannedFinish?: Date | null;
  hasDelayReason?: boolean;
  /** PROCESS_PLAN only: has mapped steps/operations, so its status is derived. */
  derived?: boolean;
  /** J6: set on a quantity-tracked row (a LOT unit's step, operation or plan); absent = counted as one. */
  qty?: { planned: number; done: number };
}

export interface FloorFacts {
  facts: UnitFacts;
  rows: Map<string, WorkRow>;
  /** The unit's (or job's) process plans by TemplateProcess seq. */
  plansBySeq: Map<number, WorkRow>;
}

export const rowKey = (kind: WorkKind, id: number) => `${kind}:${id}`;

/**
 * Review fix (14 Oct): with FEATURES.leanFloor on, the legacy step/op start
 * and submit run the D2 HARD rules recordWork runs (START: all of them; DONE:
 * H5/H6), so the legacy actions cannot bypass them. Their own legacy gates
 * still apply on top. The caller holds the unit's floor lock.
 */
export async function assertFloorHard(
  tx: Tx,
  kind: "ASSEMBLY_STEP" | "COMPONENT_OP",
  id: number,
  phase: "START" | "DONE",
): Promise<void> {
  const job = { select: { id: true, familyId: true } } as const;
  const src =
    kind === "ASSEMBLY_STEP"
      ? // j5c: history (lookup by id; the caller's lock already refused a retired row)
        await tx.assemblyStep.findUniqueOrThrow({ where: { id }, select: { unitId: true, job } })
      : await tx.componentOperation
          .findUniqueOrThrow({ where: { id }, select: { component: { select: { unitId: true } }, job } })
          .then((o) => ({ unitId: o.component.unitId, job: o.job }));
  const facts = await loadFloorFacts(tx, src.job, src.unitId);
  const row = facts.rows.get(rowKey(kind, id));
  const hard = row ? evaluateHard(row.item, facts.facts, phase) : null;
  if (hard) throw new AppError(hard.code, hard.meta);
}

const numericSeq = (code: string) => (/^\d+$/.test(code) ? Number(code) : null);

export async function loadFloorFacts(
  tx: Tx,
  job: { id: number; familyId: number },
  unitId: number | null,
): Promise<FloorFacts> {
  // J3a: a unit on its own route (another template version than the job's) is gated by that route's
  // exclusions, not by the job-level ones; every other unit, and the job view, as before.
  const unitRoute =
    unitId == null
      ? undefined
      : await tx.unit
          .findUnique({
            where: { id: unitId },
            select: { equipment: { select: { id: true, templateVersionId: true, job: { select: { templateVersionId: true } } } } },
          })
          .then((u) => (u ? routeKey(u.equipment.job.templateVersionId, u.equipment) : null));
  const [steps, ops, plans, excluded, resolveSeq] = await Promise.all([
    unitId == null
      ? Promise.resolve([])
      : tx.assemblyStep.findMany({
          where: { ...activeRow, unitId, jobId: job.id },
          select: {
            id: true,
            seq: true,
            status: true,
            requiresQc: true,
            role: true,
            jointRef: true,
            pressurePart: true,
            startedAt: true,
            reportedStartAt: true,
            weldJointId: true,
            qcpItemId: true,
            qtyPlanned: true,
            qtyDone: true,
            templateStep: { select: { kind: true, jointRef: true, scope: true, leadTimeProcessSeq: true, defaultDepartmentId: true } },
          },
        }),
    tx.componentOperation.findMany({
      where: { ...activeRow, jobId: job.id, component: { unitId, ...activeRow } },
      select: {
        id: true,
        seq: true,
        status: true,
        requiresQc: true,
        startedAt: true,
        reportedStartAt: true,
        operationId: true,
        qtyPlanned: true,
        qtyGood: true,
        operation: { select: { code: true, defaultDepartmentId: true, requiresDftGate: true } },
        component: { select: { id: true, routeVersionId: true, pressureRetaining: true, governingDrawingId: true } },
      },
    }),
    tx.processPlan.findMany({
      where: {
        jobId: job.id,
        scheduleRun: { isCurrent: true },
        // JOB-grain plans (unitId null) belong to every unit's facts too (D2 SOFT on processes 1–11, PAINT_AFTER_HYDRO).
        OR: unitId == null ? [{ unitId: null }] : [{ unitId: null }, { unitId }],
      },
      select: {
        id: true,
        status: true,
        unitId: true,
        jobProcessId: true,
        plannedFinish: true,
        actualStart: true,
        reportedStartAt: true,
        ownerDepartmentId: true,
        qtyPlanned: true,
        qtyDone: true,
        jobProcess: { select: { code: true, requiresQc: true } },
        _count: { select: { delayReasons: true } },
      },
    }),
    tx.jobProcess.findMany({
      where: { jobId: job.id, included: false, ...(unitRoute === undefined ? {} : routeWhere(unitRoute)) },
      select: { code: true },
    }),
    loadOpSeqResolver(tx, job.familyId),
  ]);
  // Component route order: position in the canonical route (legacy
  // findPreviousComponentOperation's notion), extras after it by raw seq.
  const routeVersionIds = [...new Set(ops.map((o) => o.component.routeVersionId).filter((v): v is number => v != null))];
  const routeSteps = routeVersionIds.length
    ? await tx.routeStep.findMany({
        where: { routeVersionId: { in: routeVersionIds } },
        orderBy: { seq: "asc" },
        select: { routeVersionId: true, operationId: true },
      })
    : [];
  const routeSeq = (o: (typeof ops)[number]) => {
    if (o.component.routeVersionId == null) return o.seq;
    const idx = routeSteps
      .filter((s) => s.routeVersionId === o.component.routeVersionId)
      .findIndex((s) => s.operationId === o.operationId);
    return idx >= 0 ? idx : 10_000 + o.seq;
  };

  // H2 / H3 inputs for the components on this unit.
  const componentIds = [...new Set(ops.map((o) => o.component.id))];
  const drawingIds = [...new Set(ops.map((o) => o.component.governingDrawingId).filter((d): d is number => d != null))];
  const [issues, identifications, revisions] = await Promise.all([
    componentIds.length
      ? tx.stockTxn.findMany({
          where: { componentId: { in: componentIds }, type: "ISSUE" },
          select: { componentId: true, stockLot: { select: { heatNumber: true } } },
        })
      : Promise.resolve([]),
    componentIds.length
      ? tx.materialIdentification.findMany({ where: { componentId: { in: componentIds } }, select: { componentId: true } })
      : Promise.resolve([]),
    // RLS (job_isolation) hides another job's revisions, so a cross-job link reads NOT_RELEASED.
    drawingIds.length
      ? tx.drawingRevision.findMany({
          where: { assemblyDrawingId: { in: drawingIds } },
          orderBy: { revisionNo: "desc" },
          select: { id: true, assemblyDrawingId: true, status: true, atRiskReleasedAt: true },
        })
      : Promise.resolve([]),
  ]);
  const issued = new Set(issues.map((t) => t.componentId));
  const heatPicked = new Set([
    ...identifications.map((m) => m.componentId),
    ...issues.filter((t) => t.stockLot.heatNumber).map((t) => t.componentId),
  ]);
  const currentRevision = new Map<number, (typeof revisions)[number]>();
  for (const r of revisions) if (!currentRevision.has(r.assemblyDrawingId)) currentRevision.set(r.assemblyDrawingId, r);

  // D12: an uncleared blocking H point on a step's own QcpItem.
  const stepQcpIds = steps.map((s) => s.qcpItemId).filter((q): q is number => q != null);
  const blockingQcp = stepQcpIds.length
    ? await tx.qcpItem.findMany({
        where: { id: { in: stepQcpIds }, partyCodes: { some: { qcpCode: { blocksCompletion: true } } } },
        select: { id: true },
      })
    : [];
  const openQcp = new Set(unitId == null ? [] : await openQcpItemIdsForUnit(tx, unitId, blockingQcp.map((q) => q.id)));

  const rows = new Map<string, WorkRow>();
  const plansBySeq = new Map<number, WorkRow>();
  const items: FloorItem[] = [];

  for (const s of steps) {
    const item: StepItem = {
      kind: "ASSEMBLY_STEP",
      id: s.id,
      status: s.status as ItemStatus,
      processSeq: s.templateStep.leadTimeProcessSeq,
      openBlockingHold: s.qcpItemId != null && openQcp.has(s.qcpItemId),
      seq: s.seq,
      stepKind: s.templateStep.kind,
      role: s.role,
      jointRef: s.jointRef,
      pressurePart: s.pressurePart,
    };
    items.push(item);
    rows.set(rowKey(item.kind, item.id), {
      item,
      unitId,
      requiresQc: s.requiresQc,
      departmentId: s.templateStep.defaultDepartmentId,
      startedAt: s.reportedStartAt ?? s.startedAt,
      stepKind: s.templateStep.kind,
      templateJointRef: requiredJointRef(s),
      weldJointId: s.weldJointId,
      ...(s.qtyPlanned != null ? { qty: { planned: s.qtyPlanned, done: s.qtyDone } } : {}),
    });
  }

  const isLot = unitId != null && (await lotQtyByUnit(tx, [unitId])).has(unitId);
  for (const o of ops) {
    const drawingId = o.component.governingDrawingId;
    const current = drawingId != null ? currentRevision.get(drawingId) : undefined;
    const item: OpItem = {
      kind: "COMPONENT_OP",
      id: o.id,
      status: o.status as ItemStatus,
      processSeq: resolveSeq({ operationId: o.operationId, seq: o.seq, routeVersionId: o.component.routeVersionId }),
      // ponytail: no QCP link exists at component-op grain yet, so HOLD_LINK never fires on ops.
      openBlockingHold: false,
      componentId: o.component.id,
      routeSeq: routeSeq(o),
      opCode: o.operation.code,
      pressureRetaining: o.component.pressureRetaining,
      materialIssued: issued.has(o.component.id),
      heatPicked: heatPicked.has(o.component.id),
      drawing: drawingStateOf(current ?? null, drawingId != null),
    };
    items.push(item);
    const state = item.drawing;
    rows.set(rowKey(item.kind, item.id), {
      item,
      unitId,
      requiresQc: o.requiresQc,
      departmentId: o.operation.defaultDepartmentId,
      startedAt: o.reportedStartAt ?? o.startedAt,
      componentId: o.component.id,
      requiresDftGate: o.operation.requiresDftGate,
      currentRevisionId: state === "RELEASED" || state === "AT_RISK" ? current!.id : null,
      // J6: a serial operation's qtyPlanned (pieces per assembly) is not a lot count.
      ...(isLot && o.qtyPlanned != null ? { qty: { planned: o.qtyPlanned, done: o.qtyGood ?? 0 } } : {}),
    });
  }

  const mappedSeqs = new Set(items.map((i) => i.processSeq).filter((s): s is number => s != null));
  for (const p of plans) {
    const processSeq = numericSeq(p.jobProcess.code);
    const item: PlanItem = {
      kind: "PROCESS_PLAN",
      id: p.id,
      status: p.status,
      processSeq,
      openBlockingHold: false,
    };
    items.push(item);
    const row: WorkRow = {
      item,
      unitId: p.unitId,
      requiresQc: p.jobProcess.requiresQc,
      departmentId: p.ownerDepartmentId,
      startedAt: p.reportedStartAt ?? p.actualStart,
      jobProcessId: p.jobProcessId,
      plannedFinish: p.plannedFinish,
      hasDelayReason: p._count.delayReasons > 0,
      // L1.3: a JOB-grain (unit-less) plan is derived too, from the mapped items on every unit.
      derived: processSeq != null && mappedSeqs.has(processSeq),
      ...(p.qtyPlanned != null ? { qty: { planned: p.qtyPlanned, done: p.qtyDone } } : {}),
    };
    rows.set(rowKey(item.kind, item.id), row);
    // A unit plan wins over a job plan for the same seq (a process is one grain or the other).
    if (processSeq != null && (!plansBySeq.has(processSeq) || p.unitId != null)) plansBySeq.set(processSeq, row);
  }

  // L1.2f: H5/H6 NCRs accepted per a code clause exempt only their own target.
  const concessionNcrs =
    steps.length || ops.length
      ? await tx.ncr.findMany({
          where: {
            jobId: job.id,
            disposition: "CONCESSION",
            ruleCode: { not: null },
            OR: [
              { targetAssemblyStepId: { in: steps.map((s) => s.id) } },
              { targetComponentOperationId: { in: ops.map((o) => o.id) } },
            ],
          },
          select: { ruleCode: true, targetAssemblyStepId: true, targetComponentOperationId: true },
        })
      : [];

  const hasAssemblySequence =
    unitId != null ? steps.length > 0 : (await tx.assemblyStep.count({ where: { ...activeRow, jobId: job.id } })) > 0;

  return {
    facts: {
      items,
      excludedProcessSeqs: excluded.map((e) => numericSeq(e.code)).filter((s): s is number => s != null),
      hasAssemblySequence,
      concessions: concessionNcrs.map((n) =>
        n.targetAssemblyStepId != null
          ? { rule: n.ruleCode!, kind: "ASSEMBLY_STEP" as const, id: n.targetAssemblyStepId }
          : { rule: n.ruleCode!, kind: "COMPONENT_OP" as const, id: n.targetComponentOperationId! },
      ),
    },
    rows,
    plansBySeq,
  };
}
