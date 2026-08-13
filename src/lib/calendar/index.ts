/**
 * Working-day arithmetic.
 *
 * Isolated in its own module per BUILD-SPEC-v2 §1.6 because open question C1
 * — are the lead-time table's "Days" working days or calendar days? — is still
 * unanswered, and the answer changes every computed date in the product.
 *
 * ## Two conventions that must never drift
 *
 * 1. **All dates are UTC calendar dates.** Prisma `@db.Date` columns come back
 *    as UTC midnight, and the product stores UTC / displays IST. Doing this
 *    math in local time silently shifts dates by one for anyone east of UTC,
 *    which is everyone at DESPL. Every helper here reads `getUTC*` and steps
 *    in whole UTC days; none of them look at local time.
 *
 * 2. **Day 0 is the anchor date itself.** `workingDaysBetween(a, b)` counts
 *    working days in the half-open range `(a, b]` — the anchor does not count,
 *    the destination does. So a PO raised on Wednesday has its first working
 *    day on Thursday. This is the convention that makes DE0467 come out at 97
 *    working days available; the inclusive reading gives 98 and shifts every
 *    downstream figure by one. It is almost certainly how the spec's stale
 *    "~26 days" figure drifted, so it is asserted directly in the tests.
 *
 * The seed calls the default policy `CALENDAR_DAYS_6DAY_WEEK`, which is a
 * confusing name: it means "every day except Sunday counts", not "every day".
 * Nothing here is named `calendarDays` for that reason.
 */

/** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
export const MONDAY = 1;
export const SUNDAY = 7;

export interface WorkCalendar {
  /** ISO weekday numbers that are non-working. `[7]` = Sundays off. */
  readonly weekOffDays: readonly number[];
  /** Non-working dates as `YYYY-MM-DD` (UTC). */
  readonly holidays: ReadonlySet<string>;
}

/**
 * DESPL's default: 6-day week, Sunday off, no holiday list yet.
 * Matches `seed/lead-time-model.json` → `calendarBasis`. Replace via
 * `WorkCalendar`/`Holiday` rows once DESPL answers C1 and supplies holidays.
 */
export const DEFAULT_CALENDAR: WorkCalendar = {
  weekOffDays: [SUNDAY],
  holidays: new Set<string>(),
};

const MS_PER_DAY = 86_400_000;

/** Build a UTC calendar date. `month` is 1-based, unlike the Date constructor. */
export function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** `YYYY-MM-DD` in UTC — the key format used for holiday lookups. */
export function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO weekday (1 = Mon … 7 = Sun). `getUTCDay()` returns 0 for Sunday. */
export function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? SUNDAY : day;
}

/** Same instant, shifted by whole UTC days. Immune to DST by construction. */
export function addCalendarDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function isWorkingDay(date: Date, calendar: WorkCalendar = DEFAULT_CALENDAR): boolean {
  if (calendar.weekOffDays.includes(isoWeekday(date))) return false;
  return !calendar.holidays.has(toYmd(date));
}

/**
 * Guards against a calendar with no working days at all, which would make
 * every walk below loop forever. Cheap to check, impossible to debug if missed.
 */
function assertHasWorkingDays(calendar: WorkCalendar): void {
  if (calendar.weekOffDays.length >= 7) {
    throw new Error("WorkCalendar has no working days: weekOffDays covers the whole week");
  }
}

/**
 * Working days in `(from, to]` — see convention 2 above.
 *
 * Symmetric: if `to` precedes `from` the result is negative, so callers can
 * detect a delivery date that falls before its PO date rather than seeing a
 * misleading zero.
 */
export function workingDaysBetween(
  from: Date,
  to: Date,
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): number {
  if (to.getTime() === from.getTime()) return 0;
  if (to < from) return -workingDaysBetween(to, from, calendar);

  assertHasWorkingDays(calendar);
  let count = 0;
  let cursor = addCalendarDays(from, 1);
  while (cursor <= to) {
    if (isWorkingDay(cursor, calendar)) count += 1;
    cursor = addCalendarDays(cursor, 1);
  }
  return count;
}

/**
 * The date `n` working days after `from` (or before, for negative `n`).
 *
 * `n = 0` returns `from` unchanged even when `from` is itself a non-working
 * day — an offset of zero means "the anchor", not "the next working day".
 * Round-trips with `workingDaysBetween` for every n ≥ 0, which is the property
 * the whole engine leans on when it converts day-offsets into real dates.
 */
export function addWorkingDays(
  from: Date,
  n: number,
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): Date {
  if (n === 0) return new Date(from.getTime());

  assertHasWorkingDays(calendar);
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  let cursor = from;
  while (remaining > 0) {
    cursor = addCalendarDays(cursor, step);
    if (isWorkingDay(cursor, calendar)) remaining -= 1;
  }
  return cursor;
}
