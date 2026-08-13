import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { ScheduleEdge, ScheduleProcess } from "./types";

/**
 * Dependency-graph mechanics: topological ordering, cycle refusal, and
 * bypassing processes a client has excluded.
 *
 * Kept separate from the date math because it is pure graph work — no
 * durations, no calendar, no dates — and because the excluded-process bypass
 * below is the single most dangerous operation in the engine.
 */

/** `lagDays` sign is the source of truth for the type. See `ScheduleEdge`. */
function edgeTypeForLag(lagDays: number): ScheduleEdge["type"] {
  return lagDays >= 0 ? "FINISH_TO_START" : "START_TO_START_WITH_OVERLAP";
}

/**
 * Kahn's algorithm. Refuses a cycle rather than looping or emitting a partial
 * order — a planner editing predecessors can create one at any time, and a
 * half-computed schedule is worse than a refusal the UI can explain.
 */
export function topoOrder(
  processes: readonly ScheduleProcess[],
  edges: readonly ScheduleEdge[],
): ScheduleProcess[] {
  const byCode = new Map(processes.map((p) => [p.code, p]));

  for (const edge of edges) {
    if (!byCode.has(edge.processCode) || !byCode.has(edge.predecessorCode)) {
      throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
        reason: "edge references a process that is not in the set",
        edge,
      });
    }
  }

  const indegree = new Map(processes.map((p) => [p.code, 0]));
  const successors = new Map<string, string[]>(processes.map((p) => [p.code, []]));
  for (const edge of edges) {
    indegree.set(edge.processCode, (indegree.get(edge.processCode) ?? 0) + 1);
    successors.get(edge.predecessorCode)!.push(edge.processCode);
  }

  // Seed in declared `seq` order so equally-ready processes come out in the
  // order DESPL prints them — the output is read by humans, not just machines.
  const ready = processes
    .filter((p) => indegree.get(p.code) === 0)
    .sort((a, b) => a.seq - b.seq)
    .map((p) => p.code);

  const ordered: ScheduleProcess[] = [];
  while (ready.length > 0) {
    const code = ready.shift()!;
    ordered.push(byCode.get(code)!);
    for (const next of successors.get(code)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  if (ordered.length !== processes.length) {
    const stuck = processes.filter((p) => !ordered.includes(p)).map((p) => p.code);
    throw new AppError(ERROR_CODES.SCHEDULE_CYCLE, { processes: stuck });
  }
  return ordered;
}

/**
 * Remove processes a client has excluded, rewiring the graph around them.
 *
 * **Why this is not optional.** `JobProcess.included` exists so a client can
 * skip a process — PWHT is the real case, and the DESPL-320 drawing says it is
 * not required for that vessel. But PWHT sits mid-chain: P20 → P21 → P22.
 * Dropping P21 naively leaves P22 with no predecessor at all, which makes it a
 * root that schedules on day zero — silently, with no error, producing a plan
 * that says heat treatment's successor can begin before the shell is welded.
 *
 * So each excluded process is spliced out: every predecessor is joined to every
 * successor, and the lags compose. For an excluded X with edges P → X (lag L1)
 * and X → S (lag L2), the excluded process contributes no duration, so:
 *
 *     start(X) >= finish(P) + L1     and     start(S) >= finish(X) + L2
 *     finish(X) == start(X)                  (no duration — it does not happen)
 *     =>  start(S) >= finish(P) + L1 + L2
 *
 * Chains of adjacent excluded processes fall out of this naturally because the
 * splice repeats until none are left.
 *
 * A predecessor pair reached by two different routes keeps the LARGER lag: the
 * most constraining path is the one that governs, and taking the smaller one
 * would let work start before a real dependency allows.
 */
export function bypassExcluded(
  processes: readonly ScheduleProcess[],
  edges: readonly ScheduleEdge[],
): { processes: ScheduleProcess[]; edges: ScheduleEdge[] } {
  const excluded = new Set(processes.filter((p) => !p.included).map((p) => p.code));
  const kept = processes.filter((p) => p.included);
  if (excluded.size === 0) return { processes: kept, edges: [...edges] };

  let current = [...edges];
  for (const code of excluded) {
    const incoming = current.filter((e) => e.processCode === code);
    const outgoing = current.filter((e) => e.predecessorCode === code);
    const untouched = current.filter(
      (e) => e.processCode !== code && e.predecessorCode !== code,
    );

    const spliced: ScheduleEdge[] = [];
    for (const into of incoming) {
      for (const out of outgoing) {
        // Guard against a self-edge if the graph ever routes back on itself.
        if (into.predecessorCode === out.processCode) continue;
        const lagDays = into.lagDays + out.lagDays;
        spliced.push({
          processCode: out.processCode,
          predecessorCode: into.predecessorCode,
          type: edgeTypeForLag(lagDays),
          lagDays,
        });
      }
    }
    current = [...untouched, ...spliced];
  }

  // Collapse duplicates, keeping the most constraining lag per pair.
  const strongest = new Map<string, ScheduleEdge>();
  for (const edge of current) {
    const key = `${edge.processCode}<-${edge.predecessorCode}`;
    const existing = strongest.get(key);
    if (!existing || edge.lagDays > existing.lagDays) strongest.set(key, edge);
  }

  return { processes: kept, edges: [...strongest.values()] };
}
