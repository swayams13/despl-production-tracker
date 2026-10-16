/**
 * Lean Core L2.3: the pure parts of Today. `sectionize` splits my rows into the
 * frame's sections; `buildCheckIn` turns the end-of-shift choices into the
 * writes. Kept free of React and the database so both are table-testable.
 */

export type TodayState = "READY" | "IN_PROGRESS" | "WITH_QC" | "BLOCKED" | "NEEDS_OVERRIDE" | "QC_STEP";

/** The fields sectionize reads; the screen's richer row extends it. */
export interface SectionRow {
  key: string;
  state: TodayState;
  /** ISO planned finish of the plan this row rolls up into; null = not scheduled. */
  dueAt: string | null;
  /** Done now would be late and no reason is on file. */
  lateReasonNeeded: boolean;
  /** A Supervisor or above may start an out-of-order row early. */
  canOverride: boolean;
  title: string;
}

export interface Sections<R extends SectionRow> {
  doFirst: R | null;
  today: R[];
  blocked: R[];
  upcoming: R[];
  summary: { assigned: number; needsAttention: number; dueToday: number; blocked: number };
}

const IST_MS = 5.5 * 3600 * 1000;

/** End of the IST calendar day containing `now`, as a UTC instant. */
export function endOfIstDay(now: Date): Date {
  const ist = new Date(now.getTime() + IST_MS);
  const day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return new Date(day + 24 * 3600 * 1000 - IST_MS);
}

const actionable = (r: SectionRow) =>
  r.state === "READY" || r.state === "IN_PROGRESS" || (r.state === "NEEDS_OVERRIDE" && r.canOverride);

/**
 * Rows already with QC (or QC's own steps) are not mine to do and are left
 * out. A hard stop, or an out-of-order row I may not override, is Blocked.
 * Everything else is Today when it is due by the end of the IST day (or
 * already started), else Upcoming. Do this first is one row: late with a
 * reason owed, then blocked, then due today.
 */
export function sectionize<R extends SectionRow>(rows: R[], now: Date): Sections<R> {
  const eod = endOfIstDay(now).getTime();
  const due = (r: R) => (r.dueAt ? new Date(r.dueAt).getTime() : Infinity);
  const order = (a: R, b: R) =>
    Number(b.state === "IN_PROGRESS") - Number(a.state === "IN_PROGRESS") || due(a) - due(b) || a.title.localeCompare(b.title);

  const today: R[] = [];
  const blocked: R[] = [];
  const upcoming: R[] = [];
  for (const r of rows) {
    if (r.state === "WITH_QC" || r.state === "QC_STEP") continue;
    if (!actionable(r)) blocked.push(r);
    else if (r.state === "IN_PROGRESS" || due(r) <= eod) today.push(r);
    else upcoming.push(r);
  }
  today.sort(order);
  blocked.sort(order);
  upcoming.sort(order);

  const takeFrom = (list: R[], pick: (r: R) => boolean): R | null => {
    const i = list.findIndex(pick);
    return i === -1 ? null : list.splice(i, 1)[0];
  };
  const doFirst = takeFrom(today, (r) => r.lateReasonNeeded) ?? takeFrom(blocked, () => true) ?? takeFrom(today, () => true);
  const first = doFirst ? 1 : 0;
  const firstActionable = doFirst && actionable(doFirst) ? 1 : 0;

  return {
    doFirst,
    today,
    blocked,
    upcoming,
    summary: {
      assigned: first + today.length + blocked.length + upcoming.length,
      needsAttention: [doFirst, ...today, ...blocked].filter((r) => r?.lateReasonNeeded).length,
      dueToday: today.length + firstActionable,
      blocked: blocked.length + (first - firstActionable),
    },
  };
}

// ── end-of-shift check-in ────────────────────────────────────────────────

export interface CheckInRow {
  key: string;
  kind: "COMPONENT_OP" | "ASSEMBLY_STEP" | "PROCESS_PLAN";
  id: number;
  jobId: number;
  planId: number | null;
  /** Already recorded Done today by me: shown ticked, never re-posted. */
  alreadyDone: boolean;
}
export type CheckInChoice = "DONE" | "NOT_DONE";

export interface CheckInPlan {
  /** One recordWork DONE batch per job (a request is one job). */
  done: Array<{ jobId: number; items: Array<{ kind: CheckInRow["kind"]; id: number }> }>;
  /** Plans to file a "not done" delay reason on (once each). */
  notDonePlanIds: number[];
  /** Not-done rows with no plan to hang a reason on: the sheet must say so, not drop them. */
  notDoneWithoutPlan: string[];
}

/** Only the rows the person changed are posted (errata 13). */
export function buildCheckIn(rows: CheckInRow[], choices: Record<string, CheckInChoice | undefined>): CheckInPlan {
  const byJob = new Map<number, Array<{ kind: CheckInRow["kind"]; id: number }>>();
  const notDone = new Set<number>();
  const orphan: string[] = [];
  for (const r of rows) {
    if (r.alreadyDone) continue;
    const c = choices[r.key];
    if (c === "DONE") {
      const list = byJob.get(r.jobId) ?? [];
      list.push({ kind: r.kind, id: r.id });
      byJob.set(r.jobId, list);
    } else if (c === "NOT_DONE") {
      if (r.planId != null) notDone.add(r.planId);
      else orphan.push(r.key);
    }
  }
  return {
    done: [...byJob].map(([jobId, items]) => ({ jobId, items })),
    notDonePlanIds: [...notDone],
    notDoneWithoutPlan: orphan,
  };
}
