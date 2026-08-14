import { describe, expect, it } from "vitest";
import {
  addWorkingDays,
  DEFAULT_CALENDAR,
  isWorkingDay,
  subtractWorkingDays,
  workingDaysBetween,
} from "./calendar";

// Dates as UTC noon to avoid any local-timezone date-boundary flakiness in CI.
function d(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

describe("isWorkingDay — default calendar (6-day week, Sunday off)", () => {
  const cases: { date: string; weekday: string; expected: boolean }[] = [
    { date: "2026-06-22", weekday: "Monday", expected: true },
    { date: "2026-06-27", weekday: "Saturday", expected: true },
    { date: "2026-06-28", weekday: "Sunday", expected: false },
    { date: "2026-06-24", weekday: "Wednesday", expected: true },
  ];

  it.each(cases)("$date ($weekday) -> $expected", ({ date, expected }) => {
    expect(isWorkingDay(d(date), DEFAULT_CALENDAR)).toBe(expected);
  });

  it("treats a seeded holiday as non-working even on a weekday", () => {
    const cal = { ...DEFAULT_CALENDAR, holidays: [d("2026-06-24")] };
    expect(isWorkingDay(d("2026-06-24"), cal)).toBe(false);
  });
});

describe("addWorkingDays", () => {
  it("days=0 returns the same date unchanged, even on a Sunday", () => {
    expect(addWorkingDays(d("2026-06-28"), 0, DEFAULT_CALENDAR).toISOString().slice(0, 10)).toBe(
      "2026-06-28",
    );
  });

  it("skips a Sunday when advancing across one", () => {
    // Sat 2026-06-27 + 1 working day -> Mon 2026-06-29 (Sun 28 skipped)
    expect(addWorkingDays(d("2026-06-27"), 1, DEFAULT_CALENDAR).toISOString().slice(0, 10)).toBe(
      "2026-06-29",
    );
  });

  it("rejects a negative day count", () => {
    expect(() => addWorkingDays(d("2026-06-24"), -1, DEFAULT_CALENDAR)).toThrow();
  });

  it("is the exact inverse of workingDaysBetween when the end date is itself a working day", () => {
    const start = d("2026-06-24"); // Wed
    const end = d("2026-10-15"); // Thu — the DE0467 regression dates
    const n = workingDaysBetween(start, end, DEFAULT_CALENDAR);
    expect(addWorkingDays(start, n, DEFAULT_CALENDAR).toISOString().slice(0, 10)).toBe(
      "2026-10-15",
    );
  });
});

describe("subtractWorkingDays — the mirror of addWorkingDays, for backward scheduling", () => {
  it("days=0 returns the same date unchanged", () => {
    expect(subtractWorkingDays(d("2026-06-28"), 0, DEFAULT_CALENDAR).toISOString().slice(0, 10)).toBe(
      "2026-06-28",
    );
  });

  it("skips a Sunday when going backward across one", () => {
    // Mon 2026-06-29 - 1 working day -> Sat 2026-06-27 (Sun 28 skipped)
    expect(
      subtractWorkingDays(d("2026-06-29"), 1, DEFAULT_CALENDAR).toISOString().slice(0, 10),
    ).toBe("2026-06-27");
  });

  it("is the exact inverse of addWorkingDays over the same span", () => {
    const start = d("2026-06-24");
    const forward = addWorkingDays(start, 97, DEFAULT_CALENDAR);
    expect(subtractWorkingDays(forward, 97, DEFAULT_CALENDAR).toISOString().slice(0, 10)).toBe(
      "2026-06-24",
    );
  });
});

describe("workingDaysBetween — the DE0467 regression window", () => {
  it("PO 2026-06-24 to delivery 2026-10-15 is 113 calendar days, 16 Sundays, 97 working days", () => {
    // Hand-verified: day-of-year 175 (Wed) to 288 (Thu) = 113 calendar days;
    // Sundays fall on day-of-year 179, 186, ... 284 = 16 of them.
    expect(workingDaysBetween(d("2026-06-24"), d("2026-10-15"), DEFAULT_CALENDAR)).toBe(97);
  });

  it("is 0 for the same start and end date", () => {
    expect(workingDaysBetween(d("2026-06-24"), d("2026-06-24"), DEFAULT_CALENDAR)).toBe(0);
  });

  it("excludes a seeded holiday from the count", () => {
    // 2026-06-22 (Mon) to 2026-06-27 (Sat): 5 working days with no holiday.
    const cal = { ...DEFAULT_CALENDAR, holidays: [d("2026-06-25")] };
    expect(workingDaysBetween(d("2026-06-22"), d("2026-06-27"), cal)).toBe(4);
  });

  it("rejects an end date before the start date", () => {
    expect(() => workingDaysBetween(d("2026-06-24"), d("2026-06-20"), DEFAULT_CALENDAR)).toThrow();
  });
});
