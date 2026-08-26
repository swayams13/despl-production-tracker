/**
 * One IST (Asia/Kolkata, UTC+5:30, no DST) business-day helper for every
 * "overdue"/"on time" comparison (audit H1, Phase 0 item 0.7).
 *
 * The bug: `plannedFinish < now()` (a raw timestamp compare) flips a plan
 * overdue at 00:00 UTC = 05:30 IST on its own due date — a full working day
 * early, and every "on time" KPI inherits the same pessimism via
 * `actualFinish <= plannedFinish`.
 *
 * The fix is NOT to shift stored dates. `plannedFinish`/`committedDeliveryDate`
 * etc. are already pure calendar-day markers stored at UTC midnight
 * (lib/schedule/calendar.ts's `toDateOnly` — the whole scheduling engine
 * works in timezone-naive calendar days). What needs the IST shift is turning
 * a real instant (`now()`, `actualFinish` — genuine server-clock timestamps,
 * invariant #1) into "which calendar day is this, in IST" — encoded the same
 * way, as a UTC-midnight marker, so the two can be compared with a plain
 * Date `<`/`<=`. That equivalence is what makes `istCalendarDayMarker`'s
 * result usable directly as a Prisma filter bound, not just in application code.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The UTC-midnight marker for `instant`'s calendar date in IST. Comparable
 * with any stored calendar-day field via plain `<`/`<=`/`>`/`>=`. */
export function istCalendarDayMarker(instant: Date = new Date()): Date {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** A plan/job is overdue once its due calendar day has fully passed IN IST —
 * not at UTC midnight (05:30 IST), the bug this helper closes. `asOf`
 * defaults to now; pass a fixed value for a Prisma filter bound so multiple
 * predicates in the same query agree on one instant. */
export function isOverdue(dueDate: Date | null, asOf: Date = new Date()): boolean {
  if (!dueDate) return false;
  return dueDate < istCalendarDayMarker(asOf);
}

/** Finished on or before its due calendar day, IN IST — verifying at 16:00
 * IST on the due date must count as on time, not late. */
export function isOnTime(actualFinish: Date | null, dueDate: Date | null): boolean {
  if (!actualFinish || !dueDate) return false;
  return istCalendarDayMarker(actualFinish) <= dueDate;
}
