/**
 * Lean Core L2.5: the pure parts of Team. `summarizeTeam` builds the workload
 * table and the header numbers (which add up: open = assigned + unassigned);
 * `sameDayRate` is the pilot's headline metric. No React, no database.
 */

export type TeamPlanState = "BLOCKED" | "READY" | "IN_PROGRESS" | "SUBMITTED" | "ON_HOLD" | "DONE";

export interface TeamPlanFact {
  planId: number;
  assigneeId: number | null;
  state: TeamPlanState;
  overdue: boolean;
  /** ISO planned finish; null = not scheduled. */
  dueAt: string | null;
}

export interface TeamMember {
  userId: number;
  name: string;
}

export interface PersonLoad {
  userId: number;
  name: string;
  assigned: number;
  overdue: number;
  dueToday: number;
  blocked: number;
  /** "2 d" past its date, "today", or "—" (nothing late or due). */
  oldest: string;
  idle: boolean;
}

export interface TeamSummary {
  people: PersonLoad[];
  open: number;
  assigned: number;
  unassigned: number;
  overdue: number;
  blocked: number;
}

const IST_MS = 5.5 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const istDayNo = (ms: number) => Math.floor((ms + IST_MS) / DAY);

/** "2 d" for an item that many IST days past its date, "today" if due today, else "—". */
export function oldestLabel(dueAts: Array<string | null>, now: Date): string {
  const today = istDayNo(now.getTime());
  const days = dueAts.filter((d): d is string => !!d).map((d) => today - istDayNo(new Date(d).getTime()));
  if (days.length === 0) return "—";
  const worst = Math.max(...days);
  if (worst >= 1) return `${worst} d`;
  return worst === 0 ? "today" : "—";
}

export function summarizeTeam(plans: TeamPlanFact[], members: TeamMember[], now: Date): TeamSummary {
  const today = istDayNo(now.getTime());
  const open = plans.filter((p) => p.state !== "DONE");
  const people: PersonLoad[] = members.map((m) => {
    const mine = open.filter((p) => p.assigneeId === m.userId);
    return {
      userId: m.userId,
      name: m.name,
      assigned: mine.length,
      overdue: mine.filter((p) => p.overdue).length,
      dueToday: mine.filter((p) => !p.overdue && p.dueAt != null && istDayNo(new Date(p.dueAt).getTime()) === today).length,
      blocked: mine.filter((p) => p.state === "BLOCKED").length,
      oldest: oldestLabel(mine.map((p) => p.dueAt), now),
      idle: mine.length === 0,
    };
  });
  people.sort((a, b) => b.overdue - a.overdue || b.assigned - a.assigned || a.name.localeCompare(b.name));

  // Held by someone who is not (or no longer) a member still counts as assigned.
  const assigned = open.filter((p) => p.assigneeId != null).length;
  return {
    people,
    open: open.length,
    assigned,
    unassigned: open.length - assigned,
    overdue: open.filter((p) => p.overdue).length,
    blocked: open.filter((p) => p.state === "BLOCKED").length,
  };
}

/** Least-loaded first, for the Assign to… list (ties by name). */
export function leastLoadedFirst<T extends { name: string; assigned: number }>(people: T[]): T[] {
  return [...people].sort((a, b) => a.assigned - b.assigned || a.name.localeCompare(b.name));
}

export interface UpdateEvent {
  recordedAt: Date;
  /** The client-reported time; null = entered when it happened. */
  reportedAt: Date | null;
}

/**
 * Pilot metric (D4 refinement 3): an update is same-day when its IST calendar
 * day is the day it happened. null = no events in the window.
 */
export function sameDayRate(events: UpdateEvent[]): { rate: number | null; same: number; total: number } {
  const same = events.filter((e) => !e.reportedAt || istDayNo(e.recordedAt.getTime()) === istDayNo(e.reportedAt.getTime())).length;
  return { rate: events.length ? Math.round((same / events.length) * 100) : null, same, total: events.length };
}

export interface AdoptionDay {
  /** IST calendar day, YYYY-MM-DD. */
  day: string;
  rate: number | null;
  same: number;
  total: number;
}

const dayLabel = (dayNo: number) => new Date(dayNo * DAY).toISOString().slice(0, 10);
const isSunday = (dayNo: number) => (dayNo + 4) % 7 === 0; // 1 Jan 1970 was a Thursday

/** L3.1: same-day rate per IST day (the day the update was recorded), oldest first, ending today. */
export function sameDayByDay(events: UpdateEvent[], now: Date, days: number): AdoptionDay[] {
  const today = istDayNo(now.getTime());
  return Array.from({ length: days }, (_, i) => {
    const dayNo = today - (days - 1 - i);
    const r = sameDayRate(events.filter((e) => istDayNo(e.recordedAt.getTime()) === dayNo));
    return { day: dayLabel(dayNo), rate: r.rate, same: r.same, total: r.total };
  });
}

/**
 * The pilot gate: consecutive working days at or above `target` %, counted back
 * from the latest day. Sundays are off (D1, provisional); today is skipped while
 * it has no updates yet, so a quiet morning does not break the run.
 */
export function adoptionStreak(series: AdoptionDay[], target = 90): number {
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const d = series[i]!;
    const dayNo = Math.floor(Date.parse(d.day) / DAY);
    if (isSunday(dayNo) || (i === series.length - 1 && d.total === 0)) continue;
    if (d.rate === null || d.rate < target) break;
    n++;
  }
  return n;
}
