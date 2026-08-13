import { DEFAULT_CALENDAR, addWorkingDays, workingDaysBetween, type WorkCalendar } from "@/lib/calendar";
import { assertEnvelopeKnown, resolveDurationDays } from "./duration";
import type { FeasibilityResult, PlannedProcess, ScheduleProcess } from "./types";

/**
 * Layer 1 — the envelope (BUILD-SPEC-v2 §1.2).
 *
 * The printed cumulative lead-time column is authoritative: it is what DESPL
 * quotes, and it reproduces the stated ~17 weeks exactly. It is NOT the sum of
 * the per-process durations — summing them gives 11.6–24 weeks, because the
 * table encodes heavy concurrent fabrication (CLAUDE.md invariant #10).
 *
 * So the envelope is read straight off the seeded figures rather than derived.
 */

/** Terminal envelope = the largest cumulative figure across included processes. */
function terminalEnvelope(processes: readonly ScheduleProcess[]): {
  minDays: number;
  maxDays: number;
} {
  const included = processes.filter((p) => p.included);
  return {
    minDays: Math.max(...included.map((p) => p.envelopeFinishByMinDays!)),
    maxDays: Math.max(...included.map((p) => p.envelopeFinishByMaxDays!)),
  };
}

/**
 * Plan every process from the printed envelope.
 *
 *     finish[i] = projectStart + envelopeFinishByMaxDays[i]
 *     start[i]  = finish[i] - duration[i]
 *
 * `start` is derived rather than read from `envelopeStartByMaxDays` because
 * `JobProcess` does not carry the startBy columns — only `TemplateProcess`
 * does. That is safe: the subtraction reproduces all 36 seeded startBy values
 * exactly, with zero mismatches.
 */
export function envelopePlan(
  processes: readonly ScheduleProcess[],
  projectStart: Date,
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PlannedProcess[] {
  assertEnvelopeKnown(processes);

  return processes
    .filter((p) => p.included)
    .sort((a, b) => a.seq - b.seq)
    .map((p) => {
      const finishOffset = p.envelopeFinishByMaxDays!;
      const startOffset = finishOffset - resolveDurationDays(p);
      return {
        code: p.code,
        name: p.name,
        seq: p.seq,
        startOffset,
        finishOffset,
        start: addWorkingDays(projectStart, startOffset, calendar),
        finish: addWorkingDays(projectStart, finishOffset, calendar),
      };
    });
}

/**
 * Feasibility at tender stage, before the order is accepted (BUILD-SPEC-v2 §1.5).
 *
 * This is the check that would have caught DE0467: accepted on a timeline
 * 22 working days shorter than DESPL's own standard lead time.
 *
 * ## `TIGHT` is currently unreachable, and that is a data fact, not a bug
 *
 * The branch exists because the spec defines three outcomes, and other product
 * families may yet have a min/max spread. For Pressure Vessel today they do
 * not: the terminal process prints a single figure, so
 * `finishByMinDays == finishByMaxDays == 119` and any run either clears both
 * bounds or fails both. Per DESPL's own table there is no documented "fast"
 * case for a pressure vessel. Left implemented and documented rather than
 * removed, so the day a family arrives with a real spread it simply works.
 *
 * ## The delivery date must be the EARLIEST of a committed window
 *
 * DE0467's source dispatch field reads `15.10.2026 - 25.10.2026`. Read as the
 * 25th it is 14 working days short; as the 15th, 22. The earliest is the date
 * a warning should fire against — the point of the check is to raise the risk
 * before the order is signed, not to find the most forgiving reading of it.
 */
export function checkFeasibility(
  processes: readonly ScheduleProcess[],
  poDate: Date,
  requiredDelivery: Date,
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): FeasibilityResult {
  assertEnvelopeKnown(processes);

  const { minDays, maxDays } = terminalEnvelope(processes);
  const availableDays = workingDaysBetween(poDate, requiredDelivery, calendar);

  if (availableDays >= maxDays) {
    return {
      feasibility: "FEASIBLE",
      availableDays,
      requiredMinDays: minDays,
      requiredMaxDays: maxDays,
      shortfallDays: null,
    };
  }
  if (availableDays >= minDays) {
    return {
      feasibility: "TIGHT",
      availableDays,
      requiredMinDays: minDays,
      requiredMaxDays: maxDays,
      shortfallDays: null,
    };
  }
  return {
    feasibility: "INFEASIBLE",
    availableDays,
    requiredMinDays: minDays,
    requiredMaxDays: maxDays,
    shortfallDays: minDays - availableDays,
  };
}
