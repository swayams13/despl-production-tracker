import type { WorkCalendarInput } from "./types";

/**
 * Calendar math, isolated in its own module per BUILD-SPEC-v2 §1.6: C1
 * (whether the lead-time table's "Days" are working or calendar days) is the
 * highest-impact open question with DESPL and is expected to change this
 * file without touching envelope/cpm/feasibility, which only ever call it.
 *
 * Default per BUILD-SPEC-v2 §1.6: calendar days, 6-day week, Sunday off, no
 * holiday list. "Working day" here means "a day the lead-time table's day
 * counts include" — i.e. every day except the weekly off-day(s) and any
 * seeded holidays.
 */

function toDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoWeekday(d: Date): number {
  const jsDay = d.getUTCDay(); // 0=Sunday..6=Saturday
  return jsDay === 0 ? 7 : jsDay;
}

export function isWorkingDay(date: Date, calendar: WorkCalendarInput): boolean {
  const d = toDateOnly(date);
  if (calendar.weekOffDays.includes(isoWeekday(d))) return false;
  if (calendar.holidays?.some((h) => toDateOnly(h).getTime() === d.getTime())) return false;
  return true;
}

/**
 * The date reached by advancing `days` working days from `date`.
 *
 * days = 0 returns `date` itself, unchanged, regardless of whether it is a
 * working day — this is what lets envelope.startByMinDays = 0 mean "starts
 * the same day as project start" (P1: PO Receipt & Order Review).
 *
 * This is the deliberate inverse of workingDaysBetween: for any start/end
 * where `end` is itself a working day,
 *   addWorkingDays(start, workingDaysBetween(start, end, cal), cal) === end
 */
export function addWorkingDays(date: Date, days: number, calendar: WorkCalendarInput): Date {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`addWorkingDays: days must be a non-negative integer, got ${days}`);
  }
  let cursor = toDateOnly(date);
  let remaining = days;
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (isWorkingDay(cursor, calendar)) remaining -= 1;
  }
  return cursor;
}

/**
 * The mirror of addWorkingDays: the date reached by going `days` working
 * days backward from `date`. Used by backward scheduling (BUILD-SPEC-v2
 * §1.4) to anchor per-process late-finish day-offsets to a real calendar
 * date when the known fixed point is a required delivery date, not a start
 * date.
 */
export function subtractWorkingDays(date: Date, days: number, calendar: WorkCalendarInput): Date {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`subtractWorkingDays: days must be a non-negative integer, got ${days}`);
  }
  let cursor = toDateOnly(date);
  let remaining = days;
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    if (isWorkingDay(cursor, calendar)) remaining -= 1;
  }
  return cursor;
}

/**
 * Count of working days in (start, end] — i.e. strictly after `start`, up to
 * and including `end`. This is the "available" figure in BUILD-SPEC-v2 §1.5's
 * feasibility check: the number of working days a job has between its PO
 * date and its required delivery date to get everything done.
 */
export function workingDaysBetween(start: Date, end: Date, calendar: WorkCalendarInput): number {
  const from = toDateOnly(start);
  const to = toDateOnly(end);
  if (to.getTime() < from.getTime()) {
    throw new Error("workingDaysBetween: end is before start");
  }
  let count = 0;
  let cursor = from;
  while (cursor.getTime() < to.getTime()) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (isWorkingDay(cursor, calendar)) count += 1;
  }
  return count;
}

/** BUILD-SPEC-v2 §1.6 default: 6-day week, Sunday off, no holidays. */
export const DEFAULT_CALENDAR: WorkCalendarInput = {
  weekOffDays: [7],
  holidays: [],
};
