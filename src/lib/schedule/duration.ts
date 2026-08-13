import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { ScheduleProcess } from "./types";

/**
 * Duration resolution and the refusal that guards it.
 *
 * The schema comment on `TemplateProcess` states the contract this implements:
 * a process that is `provisional`, or that has a null duration, must produce a
 * clear refusal — never a silent 0-day or a guessed date. PIPE_SPOOL is the
 * live case: its 16-step route was derived from a QAP's activity sequence, so
 * the ORDER is real but no duration is, and every row is `provisional` with
 * null durations. A guessed plan there would look authoritative and be fiction.
 */

/**
 * The duration the engine schedules with.
 *
 * Always the MAX (standard) duration, never the min. The CPM lags in
 * `seed/lead-time-model.json` were fitted against the max curve: replayed with
 * max durations they reproduce all 36 seeded envelope values exactly, but
 * replayed with min durations they land the terminal process on day 37 against
 * an envelope that says 119. The optimistic curve is only ever meaningful as
 * the envelope's own `finishByMinDays`, so it is not reachable from here.
 */
export function resolveDurationDays(process: ScheduleProcess): number {
  const days = process.durationOverrideDays ?? process.durationMaxDays;
  if (days === null) {
    throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, { process: process.code });
  }
  return days;
}

/** Processes with no usable duration, reported together rather than one at a time. */
function unplannable(processes: readonly ScheduleProcess[]): ScheduleProcess[] {
  return processes.filter(
    (p) =>
      p.included &&
      (p.provisional || (p.durationOverrideDays ?? p.durationMaxDays) === null),
  );
}

/**
 * Refuse the whole plan if any included process lacks a confirmed duration.
 *
 * Checked up front, across every process, so the planner sees the full list of
 * what DESPL still owes rather than discovering them one failed run at a time.
 *
 * A `provisional` process is refused even when a duration override is present:
 * the schema comment says provisional means "not meant for a real job to pin
 * against". Letting an override quietly unlock it is a policy relaxation for
 * DESPL to ask for, not one to assume.
 */
export function assertDurationsKnown(processes: readonly ScheduleProcess[]): void {
  const missing = unplannable(processes);
  if (missing.length > 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
      reason: "one or more processes have no confirmed duration",
      processes: missing.map((p) => ({
        code: p.code,
        name: p.name,
        provisional: p.provisional,
      })),
    });
  }
}

/** The envelope layer additionally needs the printed cumulative figures. */
export function assertEnvelopeKnown(processes: readonly ScheduleProcess[]): void {
  assertDurationsKnown(processes);
  const missing = processes.filter(
    (p) => p.included && (p.envelopeFinishByMaxDays === null || p.envelopeFinishByMinDays === null),
  );
  if (missing.length > 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
      reason: "one or more processes have no envelope figures",
      processes: missing.map((p) => ({ code: p.code, name: p.name })),
    });
  }
}
