import { bypassExcluded } from "./exclude";
import type { ScheduleEdge, ScheduleProcess } from "./types";

/**
 * Deterministically select the DAG's terminal process — the sink with no
 * outgoing edges, latest by standard (max) envelope finish-by among sinks.
 *
 * Selecting by max envelope alone is not enough: parallel branches routinely
 * tie on `envelopeFinishByMaxDays` (e.g. the pilot lead-time model's P33/P34/
 * P35/P36 all finish at day 119) while only the true sink has no successor.
 * Picking any tied non-sink process reads *its* envelopeFinishByMinDays for
 * feasibility instead of the real terminal's — silently wrong, and
 * nondeterministic besides, since an unordered DB read can return the tied
 * rows in any order (audit 0.9).
 *
 * `allProcesses`/`rawEdges` are the job's FULL sets, same contract as
 * bypassExcluded — pass every process including `included === false` ones and
 * their edges. bypassExcluded splices them out here so an excluded node's raw
 * edge doesn't make its predecessor look like it still has a successor.
 *
 * Ties among true sinks (which a well-formed DAG shouldn't produce, but this
 * must still resolve to something) keep the first process in bypassExcluded's
 * output order — deterministic as long as the caller passes a stably ordered
 * array (loadJobSpine orders by `seq`).
 */
export function selectTerminal(
  allProcesses: ScheduleProcess[],
  rawEdges: ScheduleEdge[],
): ScheduleProcess {
  const { processes, edges } = bypassExcluded(allProcesses, rawEdges);
  if (processes.length === 0) {
    throw new Error("selectTerminal: no processes given");
  }
  const successorIds = new Set(edges.map((e) => e.predecessorId));
  const sinks = processes.filter((p) => !successorIds.has(p.id));
  const candidates = sinks.length > 0 ? sinks : processes;
  return candidates.reduce((a, b) =>
    (b.envelopeFinishByMaxDays ?? -Infinity) > (a.envelopeFinishByMaxDays ?? -Infinity) ? b : a,
  );
}
