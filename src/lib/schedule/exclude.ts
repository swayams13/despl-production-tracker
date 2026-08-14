import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { ScheduleEdge, ScheduleProcess } from "./types";

/**
 * Splices `included === false` processes (JobProcess.included — "this client
 * skips it", e.g. PWHT on a job that doesn't need it) out of the DAG,
 * bridging each excluded node's predecessors to its successors so no
 * successor is orphaned. Neither `computeCpm` nor `computeEnvelope` may see
 * an excluded node — call this first and use its returned graph.
 *
 * Composition rule for an excluded node X with incoming edge (P -> X, lagPX)
 * and outgoing edge (X -> S, lagXS):
 *   lag = lagPX + duration(X) + lagXS
 * The duration(X) term is mandatory — it reproduces the exact forward-pass
 * arithmetic CPM would have produced with X still present:
 *   earlyStart[S] = earlyFinish[P] + lagPX + duration(X) + lagXS
 * (Dropping it would double-count nothing but silently pretend X took zero
 * days, dragging every successor early — invariant #10 territory even though
 * this composes lags rather than summing a schedule from scratch.)
 *
 * Nodes are spliced one at a time, in no particular order: each splice only
 * reads the current (already-updated) predecessor/successor edges of the
 * node being processed, so a chain of adjacent excluded nodes composes
 * correctly regardless of which one is processed first — lag composition is
 * associative. An excluded root contributes no bridge (its successors just
 * lose that incoming edge); an excluded terminal is simply dropped with its
 * incoming edge.
 */
export function bypassExcluded(
  processes: ScheduleProcess[],
  edges: ScheduleEdge[],
): { processes: ScheduleProcess[]; edges: ScheduleEdge[] } {
  const excludedIds = new Set(
    processes.filter((p) => p.included === false).map((p) => p.id),
  );
  if (excludedIds.size === 0) return { processes, edges };

  const byId = new Map(processes.map((p) => [p.id, p]));
  let workingEdges = edges;

  for (const id of excludedIds) {
    const node = byId.get(id)!;
    if (node.provisional || node.durationMaxDays == null) {
      throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, { processId: node.id, code: node.code });
    }
    const duration = node.durationMaxDays;

    const predEdges = workingEdges.filter((e) => e.processId === id);
    const succEdges = workingEdges.filter((e) => e.predecessorId === id);

    const composed: ScheduleEdge[] = [];
    for (const p of predEdges) {
      for (const s of succEdges) {
        if (p.predecessorId === s.processId) continue; // self-edge guard
        const lag = p.lagDays + duration + s.lagDays;
        composed.push({
          processId: s.processId,
          predecessorId: p.predecessorId,
          type: lag >= 0 ? "FINISH_TO_START" : "START_TO_START_WITH_OVERLAP",
          lagDays: lag,
        });
      }
    }

    workingEdges = workingEdges
      .filter((e) => e.processId !== id && e.predecessorId !== id)
      .concat(composed);
  }

  // Dedup: for any (predecessorId, processId) pair reached more than once
  // (e.g. via two different excluded nodes), keep the max-lag edge — the
  // most-constraining path governs.
  const byPair = new Map<string, ScheduleEdge>();
  for (const e of workingEdges) {
    const key = `${e.predecessorId}->${e.processId}`;
    const existing = byPair.get(key);
    if (!existing || e.lagDays > existing.lagDays) byPair.set(key, e);
  }

  return {
    processes: processes.filter((p) => !excludedIds.has(p.id)),
    edges: Array.from(byPair.values()),
  };
}
