import type { ScheduleProcess, ScheduleEdge } from "./types";

/**
 * Structural diagnostics for a process graph, for the route-authoring
 * publish check. Deliberately a sibling of cpm.ts's private
 * `topologicalOrder` rather than a refactor of it: that one guards an
 * invariant on the scheduling hot path and throws fast with no node
 * identity, this one must never throw and must name every offending node so
 * the UI can explain the refusal (invariant #12). Same ~20 lines of Kahn's,
 * opposite contract.
 *
 * Nothing here rejects — every field is a fact about the graph. Which facts
 * block a publish and which merely warn is `template.service.ts`'s call, and
 * that split is deliberate: multiple terminals, for instance, is normal (the
 * real PRESSURE_VESSEL route has three) while an unreachable node never is.
 */
export interface GraphDiagnostics {
  /** Edges pointing at a process id outside the given set. */
  danglingEdges: ScheduleEdge[];
  /** Edges where a process is its own predecessor. */
  selfEdges: ScheduleEdge[];
  /** Processes Kahn's algorithm could not emit — the cycle members. */
  cycleNodeIds: number[];
  /** Processes with no incoming edge. */
  rootIds: number[];
  /** Processes with no outgoing edge. */
  terminalIds: number[];
  /** Processes not reachable from any root by following edges forward. */
  unreachableIds: number[];
}

export function analyzeGraph(
  processes: ScheduleProcess[],
  edges: ScheduleEdge[],
): GraphDiagnostics {
  const ids = processes.map((p) => p.id);
  const idSet = new Set(ids);

  const danglingEdges = edges.filter(
    (e) => !idSet.has(e.processId) || !idSet.has(e.predecessorId),
  );
  const selfEdges = edges.filter(
    (e) => idSet.has(e.processId) && e.processId === e.predecessorId,
  );
  // Both classes are reported to the caller and then ignored, so the rest of
  // the analysis describes the graph that would exist once they are fixed —
  // one dangling edge shouldn't mask every other problem behind it.
  const usable = edges.filter(
    (e) =>
      idSet.has(e.processId) &&
      idSet.has(e.predecessorId) &&
      e.processId !== e.predecessorId,
  );

  const inDegree = new Map<number, number>(ids.map((id) => [id, 0]));
  const successors = new Map<number, number[]>(ids.map((id) => [id, []]));
  const hasOutgoing = new Set<number>();
  for (const e of usable) {
    inDegree.set(e.processId, inDegree.get(e.processId)! + 1);
    successors.get(e.predecessorId)!.push(e.processId);
    hasOutgoing.add(e.predecessorId);
  }

  const rootIds = ids.filter((id) => inDegree.get(id) === 0);
  const terminalIds = ids.filter((id) => !hasOutgoing.has(id));

  // Kahn's, collecting what it cannot emit rather than throwing.
  const remaining = new Map(inDegree);
  const queue = [...rootIds];
  const emitted = new Set<number>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    emitted.add(id);
    for (const next of successors.get(id)!) {
      const d = remaining.get(next)! - 1;
      remaining.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  const cycleNodeIds = ids.filter((id) => !emitted.has(id));

  // Forward reachability from the roots. Separate from `emitted` on purpose:
  // Kahn's holds a node back until ALL its predecessors are emitted, so a
  // node fed by both a root and a cycle is un-emitted yet genuinely reachable.
  const reached = new Set<number>(rootIds);
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of successors.get(id)!) {
      if (!reached.has(next)) {
        reached.add(next);
        stack.push(next);
      }
    }
  }
  const unreachableIds = ids.filter((id) => !reached.has(id));

  return { danglingEdges, selfEdges, cycleNodeIds, rootIds, terminalIds, unreachableIds };
}
