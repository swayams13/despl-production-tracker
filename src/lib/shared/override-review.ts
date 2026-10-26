import { DEFAULT_CALENDAR } from "@/lib/schedule/calendar";
import type { WorkCalendarInput } from "@/lib/schedule/types";
import { workingHoursBetween } from "./floor-rules";

/**
 * D2 (CLAUDE.md, "Acknowledge"): what happens to a SOFT early start after the
 * floor wrote it. Pure. Acknowledging never blocks work; these two rules only
 * decide what gets surfaced.
 */

/** Unacknowledged after 2 working days -> the digest. 24 h per working day, as in floor-rules `workingHoursBetween`. */
export const ACK_DIGEST_AFTER_WORKING_HOURS = 48;

/** The same step pair overridden on at least half of a job's units, and on at least this many -> master-data review. */
export const REVIEW_PAIR_MIN_UNITS = 3;

export const isAckStale = (createdAt: Date, now: Date, calendar: WorkCalendarInput = DEFAULT_CALENDAR): boolean =>
  workingHoursBetween(createdAt, now, calendar, ACK_DIGEST_AFTER_WORKING_HOURS) >= ACK_DIGEST_AFTER_WORKING_HOURS;

export interface StaleAckLine {
  jobNumber: string;
  count: number;
  /** ISO instant of the oldest one still waiting. */
  oldestAt: string;
}

/** One line per job: its unacknowledged overrides older than 2 working days on the job's calendar. */
export function staleAcksByJob(
  rows: ReadonlyArray<{ jobId: number; jobNumber: string; createdAt: Date }>,
  now: Date,
  calendars: ReadonlyMap<number, WorkCalendarInput>,
): StaleAckLine[] {
  const by = new Map<number, StaleAckLine>();
  for (const r of rows) {
    if (!isAckStale(r.createdAt, now, calendars.get(r.jobId))) continue;
    const g = by.get(r.jobId);
    if (!g) by.set(r.jobId, { jobNumber: r.jobNumber, count: 1, oldestAt: r.createdAt.toISOString() });
    else {
      g.count++;
      if (r.createdAt.toISOString() < g.oldestAt) g.oldestAt = r.createdAt.toISOString();
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.jobNumber.localeCompare(b.jobNumber));
}

export interface PairOverride {
  jobId: number;
  unitId: number | null;
  /** Template identity of the step started early and of the earlier step it skipped (same for every unit of the job). */
  step: string;
  skipped: string;
}

export interface ReviewPair {
  jobId: number;
  step: string;
  skipped: string;
  units: number;
  totalUnits: number;
}

/** (step, skipped) pairs overridden on >= half of a job's units and >= REVIEW_PAIR_MIN_UNITS of them. */
export function reviewPairs(rows: readonly PairOverride[], unitsByJob: ReadonlyMap<number, number>): ReviewPair[] {
  const seen = new Map<string, { pair: PairOverride; units: Set<number> }>();
  for (const r of rows) {
    if (r.unitId == null) continue;
    const k = `${r.jobId}|${r.step}|${r.skipped}`;
    const g = seen.get(k) ?? { pair: r, units: new Set<number>() };
    g.units.add(r.unitId);
    seen.set(k, g);
  }
  return [...seen.values()]
    .map(({ pair, units }) => ({ jobId: pair.jobId, step: pair.step, skipped: pair.skipped, units: units.size, totalUnits: unitsByJob.get(pair.jobId) ?? 0 }))
    .filter((p) => p.totalUnits > 0 && p.units >= REVIEW_PAIR_MIN_UNITS && p.units * 2 >= p.totalUnits)
    .sort((a, b) => b.units / (b.totalUnits || 1) - a.units / (a.totalUnits || 1) || a.jobId - b.jobId || a.step.localeCompare(b.step));
}
