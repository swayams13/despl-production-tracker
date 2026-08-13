import { DEFAULT_CALENDAR, addWorkingDays, workingDaysBetween, type WorkCalendar } from "@/lib/calendar";
import { assertDurationsKnown, resolveDurationDays } from "./duration";
import { bypassExcluded, topoOrder } from "./graph";
import type { PlannedProcess, ScheduleEdge, ScheduleProcess } from "./types";

/**
 * Layer 2 — CPM over the fitted-lag DAG (BUILD-SPEC-v2 §1.3).
 *
 * Drives live replanning when an actual date slips, and answers "what does this
 * delay push out?". The lags are fitted to the printed envelope, so a forward
 * pass with max durations lands exactly on the envelope for an untouched job —
 * asserted directly in the tests against all 36 seeded processes.
 *
 * ## Scheduling is not gating
 *
 * A negative lag lets a process START before its predecessor finishes. It never
 * lets one COMPLETE out of order, and never clears a hold point (CLAUDE.md
 * invariants #2 and #11). Nothing in this file decides whether work may
 * proceed — it computes dates. Gating lives in `lib/services/`.
 */

/** Pin a process to a date the planner chose. Cascades to everything downstream. */
export interface SchedulePin {
  readonly processCode: string;
  /** The planner-chosen start. Reason capture and audit are a services concern. */
  readonly start: Date;
}

function planFromOffsets(
  processes: readonly ScheduleProcess[],
  anchor: Date,
  offsets: ReadonlyMap<string, { startOffset: number; finishOffset: number }>,
  calendar: WorkCalendar,
): PlannedProcess[] {
  return processes
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((p) => {
      const { startOffset, finishOffset } = offsets.get(p.code)!;
      return {
        code: p.code,
        name: p.name,
        seq: p.seq,
        startOffset,
        finishOffset,
        start: addWorkingDays(anchor, startOffset, calendar),
        finish: addWorkingDays(anchor, finishOffset, calendar),
      };
    });
}

/**
 * Forward pass — earliest dates from a known project start.
 *
 *     start[i]  = max over predecessors of (finish[pred] + lag)   (0 for roots)
 *     finish[i] = start[i] + duration[i]
 *
 * Answers "when can we deliver?". `pins` implements OVERRIDE mode: a pinned
 * process takes the planner's date instead of its computed one, and the
 * cascade through its dependents falls out of the same pass. A pin only ever
 * moves the process it names — dependents are recomputed, never overwritten —
 * so the baseline stays intact (invariant #6).
 */
export function forwardPass(
  processes: readonly ScheduleProcess[],
  edges: readonly ScheduleEdge[],
  projectStart: Date,
  calendar: WorkCalendar = DEFAULT_CALENDAR,
  pins: readonly SchedulePin[] = [],
): PlannedProcess[] {
  const active = bypassExcluded(processes, edges);
  assertDurationsKnown(active.processes);

  const pinnedOffsets = new Map(
    pins.map((pin) => [pin.processCode, workingDaysBetween(projectStart, pin.start, calendar)]),
  );

  const predecessorsOf = new Map<string, ScheduleEdge[]>(
    active.processes.map((p) => [p.code, []]),
  );
  for (const edge of active.edges) predecessorsOf.get(edge.processCode)!.push(edge);

  const offsets = new Map<string, { startOffset: number; finishOffset: number }>();
  for (const process of topoOrder(active.processes, active.edges)) {
    const incoming = predecessorsOf.get(process.code)!;
    const earliest =
      incoming.length === 0
        ? 0
        : Math.max(...incoming.map((e) => offsets.get(e.predecessorCode)!.finishOffset + e.lagDays));

    const startOffset = pinnedOffsets.get(process.code) ?? earliest;
    offsets.set(process.code, {
      startOffset,
      finishOffset: startOffset + resolveDurationDays(process),
    });
  }

  return planFromOffsets(active.processes, projectStart, offsets, calendar);
}

/**
 * Backward pass — latest dates that still meet a required delivery.
 *
 * This is what drives notifications: it tells every department the date it must
 * finish by (BUILD-SPEC-v2 §1.4).
 *
 * Computed in "working days before delivery" space, then converted once. From
 * `start(S) >= finish(P) + lag`, measuring backwards flips the inequality:
 *
 *     beforeFinish[i] = max over successors of (beforeStart[succ] + lag)
 *     beforeStart[i]  = beforeFinish[i] + duration[i]
 *
 * with `beforeFinish = 0` for terminal processes. A process whose latest start
 * lands before the project start is on the critical path and short of time —
 * the caller sees that as a start date earlier than the PO date rather than as
 * a thrown error, because "how late are we" is information, not a refusal.
 */
export function backwardPass(
  processes: readonly ScheduleProcess[],
  edges: readonly ScheduleEdge[],
  requiredDelivery: Date,
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PlannedProcess[] {
  const active = bypassExcluded(processes, edges);
  assertDurationsKnown(active.processes);

  const successorsOf = new Map<string, ScheduleEdge[]>(active.processes.map((p) => [p.code, []]));
  for (const edge of active.edges) successorsOf.get(edge.predecessorCode)!.push(edge);

  const before = new Map<string, { beforeStart: number; beforeFinish: number }>();
  for (const process of topoOrder(active.processes, active.edges).reverse()) {
    const outgoing = successorsOf.get(process.code)!;
    const beforeFinish =
      outgoing.length === 0
        ? 0
        : Math.max(...outgoing.map((e) => before.get(e.processCode)!.beforeStart + e.lagDays));

    before.set(process.code, {
      beforeFinish,
      beforeStart: beforeFinish + resolveDurationDays(process),
    });
  }

  // Convert "days before delivery" into offsets from delivery (negative), so
  // the same date-materialising helper serves both passes.
  const offsets = new Map(
    [...before].map(([code, b]) => [
      code,
      { startOffset: -b.beforeStart, finishOffset: -b.beforeFinish },
    ]),
  );

  return planFromOffsets(active.processes, requiredDelivery, offsets, calendar);
}
