import { addWorkingDays, subtractWorkingDays } from "./calendar";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { ScheduleEdge, ScheduleProcess, WorkCalendarInput } from "./types";

/**
 * Layer 2 — CPM DAG with fitted lags (BUILD-SPEC-v2 §1.3). Drives live
 * replanning when an actual slips, critical-path/float, and gating (gating
 * itself lives in gating.ts — this module only computes dates).
 *
 * The forward-pass formula is uniform across both edge types the schema
 * defines:
 *   earlyStart[process] = max over predecessor edges of
 *                          (earlyFinish[predecessor] + edge.lagDays)
 * `type` (FINISH_TO_START vs START_TO_START_WITH_OVERLAP) is descriptive of
 * *why* a lag is what it is (a real gap vs. legitimate concurrent work when
 * lagDays < 0) — it does not change the arithmetic. This was verified against
 * every edge in seed/lead-time-model.json: using durationMaxDays throughout,
 * this formula reproduces the printed envelope's finishByMaxDays exactly at
 * every one of the 36 processes, including the terminal P36 = 119 days.
 */

export interface CpmNode {
  processId: number;
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  totalFloat: number;
  isCritical: boolean;
}

function resolveDuration(
  p: ScheduleProcess,
  overrides: Map<number, number> | undefined,
): number {
  const override = overrides?.get(p.id);
  if (override != null) return override;
  if (p.provisional || p.durationMaxDays == null) {
    throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, { processId: p.id, code: p.code });
  }
  return p.durationMaxDays;
}

/** Kahn's algorithm. Throws on a cycle — the DAG must be acyclic by construction. */
function topologicalOrder(processes: ScheduleProcess[], edges: ScheduleEdge[]): number[] {
  const ids = processes.map((p) => p.id);
  const idSet = new Set(ids);
  const inDegree = new Map<number, number>(ids.map((id) => [id, 0]));
  const successors = new Map<number, ScheduleEdge[]>(ids.map((id) => [id, []]));

  for (const e of edges) {
    if (!idSet.has(e.processId) || !idSet.has(e.predecessorId)) {
      throw new Error(
        `cpm: edge references a process not in the given set (process ${e.processId}, predecessor ${e.predecessorId})`,
      );
    }
    inDegree.set(e.processId, (inDegree.get(e.processId) ?? 0) + 1);
    successors.get(e.predecessorId)!.push(e);
  }

  const queue = ids.filter((id) => inDegree.get(id) === 0);
  const order: number[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of successors.get(id) ?? []) {
      const next = (inDegree.get(e.processId) ?? 0) - 1;
      inDegree.set(e.processId, next);
      if (next === 0) queue.push(e.processId);
    }
  }

  if (order.length !== ids.length) {
    throw new Error("cpm: process graph has a cycle — cannot compute a schedule");
  }
  return order;
}

/**
 * Full CPM: forward pass, then backward pass anchored to the natural project
 * end (the latest early-finish across all processes) unless a later
 * `projectEndOverride` is supplied — e.g. backward scheduling from a required
 * delivery date that leaves slack against the natural critical path.
 */
export function computeCpm(
  processes: ScheduleProcess[],
  edges: ScheduleEdge[],
  opts: { durationDaysByProcessId?: Map<number, number>; projectEndOverride?: number } = {},
): CpmNode[] {
  const order = topologicalOrder(processes, edges);
  const byId = new Map(processes.map((p) => [p.id, p]));
  const duration = new Map(order.map((id) => [id, resolveDuration(byId.get(id)!, opts.durationDaysByProcessId)]));

  const predecessorEdgesByProcess = new Map<number, ScheduleEdge[]>(order.map((id) => [id, []]));
  const successorEdgesByProcess = new Map<number, ScheduleEdge[]>(order.map((id) => [id, []]));
  for (const e of edges) {
    predecessorEdgesByProcess.get(e.processId)!.push(e);
    successorEdgesByProcess.get(e.predecessorId)!.push(e);
  }

  const earlyStart = new Map<number, number>();
  const earlyFinish = new Map<number, number>();
  for (const id of order) {
    const preds = predecessorEdgesByProcess.get(id)!;
    const es =
      preds.length === 0
        ? 0
        : Math.max(...preds.map((e) => earlyFinish.get(e.predecessorId)! + e.lagDays));
    earlyStart.set(id, es);
    earlyFinish.set(id, es + duration.get(id)!);
  }

  const projectEnd = opts.projectEndOverride ?? Math.max(...Array.from(earlyFinish.values()));

  const lateStart = new Map<number, number>();
  const lateFinish = new Map<number, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const succs = successorEdgesByProcess.get(id)!;
    const lf = succs.length === 0 ? projectEnd : Math.min(...succs.map((e) => lateStart.get(e.processId)! - e.lagDays));
    lateFinish.set(id, lf);
    lateStart.set(id, lf - duration.get(id)!);
  }

  return order.map((id) => {
    const totalFloat = lateStart.get(id)! - earlyStart.get(id)!;
    return {
      processId: id,
      earlyStart: earlyStart.get(id)!,
      earlyFinish: earlyFinish.get(id)!,
      lateStart: lateStart.get(id)!,
      lateFinish: lateFinish.get(id)!,
      totalFloat,
      isCritical: totalFloat === 0,
    };
  });
}

export interface ScheduledProcess {
  processId: number;
  earlyStartDate: Date;
  earlyFinishDate: Date;
  lateStartDate: Date;
  lateFinishDate: Date;
  totalFloatDays: number;
  isCritical: boolean;
}

export interface ForwardSchedule {
  perProcess: ScheduledProcess[];
  projectFinishDate: Date;
}

/**
 * Forward mode (BUILD-SPEC-v2 §1.4): PO/enquiry date in, earliest realistic
 * dispatch date out — "when can we deliver?"
 */
export function scheduleForward(
  processes: ScheduleProcess[],
  edges: ScheduleEdge[],
  projectStartDate: Date,
  calendar: WorkCalendarInput,
  durationDaysByProcessId?: Map<number, number>,
): ForwardSchedule {
  const cpm = computeCpm(processes, edges, { durationDaysByProcessId });
  const projectEndOffset = Math.max(...cpm.map((n) => n.earlyFinish));
  const perProcess = cpm.map((n) => ({
    processId: n.processId,
    earlyStartDate: addWorkingDays(projectStartDate, n.earlyStart, calendar),
    earlyFinishDate: addWorkingDays(projectStartDate, n.earlyFinish, calendar),
    lateStartDate: addWorkingDays(projectStartDate, n.lateStart, calendar),
    lateFinishDate: addWorkingDays(projectStartDate, n.lateFinish, calendar),
    totalFloatDays: n.totalFloat,
    isCritical: n.isCritical,
  }));
  return {
    perProcess,
    projectFinishDate: addWorkingDays(projectStartDate, projectEndOffset, calendar),
  };
}

export interface BackwardSchedule {
  perProcess: ScheduledProcess[];
  /** The PO/kick-off date required to hit `requiredDeliveryDate` with zero float. */
  requiredProjectStartDate: Date;
}

/**
 * Backward mode (BUILD-SPEC-v2 §1.4): client required delivery date in,
 * per-process finish-by date out for every department — this is what drives
 * notifications (BUILD-SPEC-v2 §4).
 *
 * Anchors the CPM's day-offset space to `requiredDeliveryDate` by running the
 * backward pass with the project end pinned at the natural critical-path
 * length (so the terminal process's late finish lands exactly on the
 * required delivery date), then mapping every offset to a real date by
 * counting backward from it.
 */
export function scheduleBackward(
  processes: ScheduleProcess[],
  edges: ScheduleEdge[],
  requiredDeliveryDate: Date,
  calendar: WorkCalendarInput,
  durationDaysByProcessId?: Map<number, number>,
): BackwardSchedule {
  const cpm = computeCpm(processes, edges, { durationDaysByProcessId });
  const span = Math.max(...cpm.map((n) => n.earlyFinish));
  const dateAt = (offset: number) => subtractWorkingDays(requiredDeliveryDate, span - offset, calendar);

  const perProcess = cpm.map((n) => ({
    processId: n.processId,
    earlyStartDate: dateAt(n.earlyStart),
    earlyFinishDate: dateAt(n.earlyFinish),
    lateStartDate: dateAt(n.lateStart),
    lateFinishDate: dateAt(n.lateFinish),
    totalFloatDays: n.totalFloat,
    isCritical: n.isCritical,
  }));
  return { perProcess, requiredProjectStartDate: dateAt(0) };
}
