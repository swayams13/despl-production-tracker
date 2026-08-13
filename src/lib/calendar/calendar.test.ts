import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR,
  addWorkingDays,
  isWorkingDay,
  isoWeekday,
  toYmd,
  utcDate,
  workingDaysBetween,
  type WorkCalendar,
} from "./index";

/**
 * The day-0 and UTC conventions documented at the top of `./index.ts` are
 * load-bearing: every date the product computes is derived from them, and the
 * spec's stale "~26 working days" figure for DE0467 is what an off-by-one here
 * looks like once it reaches a document. So these cases are hand-checked
 * against a real calendar rather than generated.
 *
 * June 2026 reference — 21 Jun 2026 is a Sunday, so:
 *   Mon 22 · Tue 23 · Wed 24 · Thu 25 · Fri 26 · Sat 27 · SUN 28 · Mon 29
 */

describe("isoWeekday — Sunday is 7, not 0", () => {
  it.each([
    { date: utcDate(2026, 6, 22), expected: 1, name: "Monday" },
    { date: utcDate(2026, 6, 27), expected: 6, name: "Saturday" },
    { date: utcDate(2026, 6, 28), expected: 7, name: "Sunday" },
  ])("$name", ({ date, expected }) => {
    expect(isoWeekday(date)).toBe(expected);
  });
});

describe("isWorkingDay", () => {
  it("counts Saturday as a working day (6-day week)", () => {
    expect(isWorkingDay(utcDate(2026, 6, 27))).toBe(true);
  });

  it("excludes Sunday", () => {
    expect(isWorkingDay(utcDate(2026, 6, 28))).toBe(false);
  });

  it("excludes a listed holiday that falls on a weekday", () => {
    const withHoliday: WorkCalendar = {
      weekOffDays: [7],
      holidays: new Set(["2026-06-25"]),
    };
    expect(isWorkingDay(utcDate(2026, 6, 25), withHoliday)).toBe(false);
    expect(isWorkingDay(utcDate(2026, 6, 25))).toBe(true);
  });
});

describe("workingDaysBetween — day 0 is the anchor, counted over (from, to]", () => {
  const cases: { name: string; from: Date; to: Date; expected: number }[] = [
    {
      name: "same day is zero, not one",
      from: utcDate(2026, 6, 22),
      to: utcDate(2026, 6, 22),
      expected: 0,
    },
    {
      name: "next day is one",
      from: utcDate(2026, 6, 22),
      to: utcDate(2026, 6, 23),
      expected: 1,
    },
    {
      name: "Sunday in the range is not counted",
      from: utcDate(2026, 6, 27), // Sat
      to: utcDate(2026, 6, 29), // Mon — skips Sun 28
      expected: 1,
    },
    {
      name: "a full week yields six working days",
      from: utcDate(2026, 6, 22),
      to: utcDate(2026, 6, 29),
      expected: 6,
    },
    {
      name: "landing on a Sunday does not count it",
      from: utcDate(2026, 6, 26), // Fri
      to: utcDate(2026, 6, 28), // Sun
      expected: 1, // only Sat 27
    },
    {
      name: "reversed range is negative, so a delivery before its PO is visible",
      from: utcDate(2026, 6, 29),
      to: utcDate(2026, 6, 22),
      expected: -6,
    },
  ];

  it.each(cases)("$name", ({ from, to, expected }) => {
    expect(workingDaysBetween(from, to)).toBe(expected);
  });
});

describe("addWorkingDays", () => {
  it("returns the anchor unchanged for n=0, even on a non-working day", () => {
    const sunday = utcDate(2026, 6, 28);
    expect(toYmd(addWorkingDays(sunday, 0))).toBe("2026-06-28");
  });

  it("skips Sunday walking forward", () => {
    // Sat 27 + 1 working day => Mon 29, not Sun 28.
    expect(toYmd(addWorkingDays(utcDate(2026, 6, 27), 1))).toBe("2026-06-29");
  });

  it("skips Sunday walking backward", () => {
    // Mon 29 - 1 working day => Sat 27.
    expect(toYmd(addWorkingDays(utcDate(2026, 6, 29), -1))).toBe("2026-06-27");
  });

  it("skips a holiday as well as the week-off day", () => {
    const withHoliday: WorkCalendar = {
      weekOffDays: [7],
      holidays: new Set(["2026-06-29"]),
    };
    // Sat 27 + 1 => Sun 28 skipped, Mon 29 is a holiday => Tue 30.
    expect(toYmd(addWorkingDays(utcDate(2026, 6, 27), 1, withHoliday))).toBe("2026-06-30");
  });

  it("round-trips with workingDaysBetween for a long span", () => {
    const start = utcDate(2026, 6, 24);
    for (const n of [1, 6, 25, 97, 119]) {
      const landed = addWorkingDays(start, n);
      expect(workingDaysBetween(start, landed)).toBe(n);
    }
  });
});

describe("UTC discipline", () => {
  it("does not shift a date when the host timezone is east of UTC", () => {
    // A local-time implementation would return 2026-06-23 for IST (UTC+5:30).
    expect(toYmd(utcDate(2026, 6, 24))).toBe("2026-06-24");
    expect(toYmd(addWorkingDays(utcDate(2026, 6, 24), 0))).toBe("2026-06-24");
  });
});

describe("degenerate calendars are refused, not looped over", () => {
  it("throws when every weekday is a week-off day", () => {
    const noWorkingDays: WorkCalendar = {
      weekOffDays: [1, 2, 3, 4, 5, 6, 7],
      holidays: new Set(),
    };
    expect(() => addWorkingDays(utcDate(2026, 6, 22), 1, noWorkingDays)).toThrow(
      /no working days/i,
    );
  });
});

describe("DE0467 — the figure the spec got wrong", () => {
  /**
   * PO 24 Jun 2026 → committed dispatch 15 Oct 2026, DESPL's default 6-day
   * week. 113 calendar days containing 16 Sundays = 97 working days.
   *
   * BUILD-SPEC-v2 §1.5 and IMPLEMENTATION-GUIDE Step 7 both assert ~26 working
   * days short of the 119-day envelope. The arithmetic gives 22. This test
   * pins the input half of that figure so the engine cannot quietly drift back.
   */
  it("counts 97 working days available", () => {
    expect(workingDaysBetween(utcDate(2026, 6, 24), utcDate(2026, 10, 15))).toBe(97);
  });

  it("counts 98 under the inclusive reading — which is how off-by-ones start", () => {
    const inclusive =
      workingDaysBetween(utcDate(2026, 6, 24), utcDate(2026, 10, 15)) +
      (isWorkingDay(utcDate(2026, 6, 24), DEFAULT_CALENDAR) ? 1 : 0);
    expect(inclusive).toBe(98);
  });
});
