import { addWorkingDays } from "./calendar";
import { bypassExcluded } from "./exclude";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { ScheduleEdge, ScheduleProcess, WorkCalendarInput } from "./types";

/**
 * Layer 1 — the printed envelope (BUILD-SPEC-v2 §1.2). Authoritative: this is
 * what reproduces DESPL's own ~17-week figure exactly and is what a tender
 * upload shows. Never derived by summing durations (invariant #10) — it reads
 * the envelope offsets straight off the template, which were fitted to the
 * printed cumulative lead-time table.
 */

export interface EnvelopeDates {
  processId: number;
  plannedStartMin: Date;
  plannedStartMax: Date;
  plannedFinishMin: Date;
  plannedFinishMax: Date;
}

/**
 * Refuses a provisional or duration-less process outright (schema.prisma's
 * TemplateProcess/JobProcess comments require this): a family with a real
 * process route but no confirmed lead-time data (e.g. PIPE_SPOOL) must never
 * silently get a 0-day or guessed date.
 */
function assertSchedulable(p: ScheduleProcess): void {
  if (
    p.provisional ||
    p.durationMinDays == null ||
    p.durationMaxDays == null ||
    p.envelopeFinishByMinDays == null ||
    p.envelopeFinishByMaxDays == null ||
    p.envelopeStartByMinDays == null ||
    p.envelopeStartByMaxDays == null
  ) {
    throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, { processId: p.id, code: p.code });
  }
}

/**
 * planned_finish[i] = project_start + envelope.finishBy*Days[i]
 * planned_start[i]  = project_start + envelope.startBy*Days[i]
 *
 * (startBy*Days is seeded pre-computed as finishBy*Days - duration*Days — see
 * seed/lead-time-model.json — so it is read directly rather than re-derived,
 * which would silently diverge from the printed table if a future duration
 * edit didn't also update the envelope.)
 *
 * `edges` is optional — this layer never does graph/lag arithmetic, so
 * `bypassExcluded` is called here purely to drop `included === false`
 * processes (e.g. an excluded PWHT must not get a planned date of its own);
 * the composed edges it returns are irrelevant to a per-process offset read
 * and go unused. Omit `edges` when nothing on the job is excluded.
 */
export function computeEnvelope(
  processes: ScheduleProcess[],
  projectStartDate: Date,
  calendar: WorkCalendarInput,
  edges: ScheduleEdge[] = [],
): EnvelopeDates[] {
  processes = bypassExcluded(processes, edges).processes;
  return processes.map((p) => {
    assertSchedulable(p);
    return {
      processId: p.id,
      plannedStartMin: addWorkingDays(projectStartDate, p.envelopeStartByMinDays!, calendar),
      plannedStartMax: addWorkingDays(projectStartDate, p.envelopeStartByMaxDays!, calendar),
      plannedFinishMin: addWorkingDays(projectStartDate, p.envelopeFinishByMinDays!, calendar),
      plannedFinishMax: addWorkingDays(projectStartDate, p.envelopeFinishByMaxDays!, calendar),
    };
  });
}
