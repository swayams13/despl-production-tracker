import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { ProcessPlanStatusInput, ScheduleEdge } from "./types";

/**
 * Gating vs scheduling are different concerns (BUILD-SPEC-v2 §1.3, CLAUDE.md
 * invariants #2 and #11). CPM lags relax the *schedule* — they let a process
 * with a negative-lag edge be marked IN_PROGRESS before its predecessor
 * finishes, because that is real, fitted concurrent fabrication. They never
 * relax *gating*: a process can never be marked COMPLETE ahead of any
 * predecessor, regardless of the edge's lag sign, and this module never
 * looks at dates at all — only at status.
 *
 * QCP hold points (invariant #4) are a separate, later concern (BUILD-SPEC-v2
 * §11, the QCP engine) — not implemented here. `assertCanComplete` is the
 * integration seam a future hold-point check composes with, not a
 * replacement for it.
 */

export interface PredecessorState {
  predecessorId: number;
  status: ProcessPlanStatusInput;
}

const STARTED_STATUSES: ProcessPlanStatusInput[] = ["IN_PROGRESS", "SUBMITTED", "COMPLETE"];

/**
 * May this process be marked IN_PROGRESS?
 *
 * - FINISH_TO_START edge: predecessor must be COMPLETE.
 * - START_TO_START_WITH_OVERLAP edge: predecessor need only have STARTED — the
 *   whole point of an overlap edge is that the two processes run concurrently.
 *
 * Keyed off `type`, NOT `lagDays` sign: an overlap edge with lagDays === 0 is
 * still concurrent work (the predecessor need only have started), so keying on
 * `lagDays >= 0` would wrongly demand the predecessor be COMPLETE for it.
 */
/** Non-throwing form of assertCanStart: which predecessors (if any) block a start. */
export function startReadiness(
  edges: ScheduleEdge[],
  predecessorStates: PredecessorState[],
): { ready: boolean; blockingPredecessorIds: number[] } {
  const statusById = new Map(predecessorStates.map((s) => [s.predecessorId, s.status]));
  const blocking = edges.filter((e) => {
    const status = statusById.get(e.predecessorId);
    if (status == null) {
      throw new Error(`startReadiness: no status given for predecessor ${e.predecessorId}`);
    }
    const required =
      e.type === "FINISH_TO_START" ? status === "COMPLETE" : STARTED_STATUSES.includes(status);
    return !required;
  });
  return { ready: blocking.length === 0, blockingPredecessorIds: blocking.map((e) => e.predecessorId) };
}

export function assertCanStart(
  edges: ScheduleEdge[],
  predecessorStates: PredecessorState[],
): void {
  const { ready, blockingPredecessorIds } = startReadiness(edges, predecessorStates);
  if (!ready) {
    throw new AppError(ERROR_CODES.GATING_BLOCKED, {
      reason: "predecessor(s) not sufficiently advanced to start",
      predecessorIds: blockingPredecessorIds,
    });
  }
}

/**
 * May this process be marked COMPLETE? Every predecessor must be COMPLETE,
 * full stop — a negative lag never lets a process finish out of order
 * (invariant #11), even though it may have started concurrently.
 */
export function assertCanComplete(
  edges: ScheduleEdge[],
  predecessorStates: PredecessorState[],
): void {
  const statusById = new Map(predecessorStates.map((s) => [s.predecessorId, s.status]));
  const blocking = edges.filter((e) => {
    const status = statusById.get(e.predecessorId);
    if (status == null) {
      throw new Error(`assertCanComplete: no status given for predecessor ${e.predecessorId}`);
    }
    return status !== "COMPLETE";
  });
  if (blocking.length > 0) {
    throw new AppError(ERROR_CODES.GATING_BLOCKED, {
      reason: "predecessor(s) not complete",
      predecessorIds: blocking.map((e) => e.predecessorId),
    });
  }
}
