import { describe, expect, it } from "vitest";
import { checkFeasibility } from "./feasibility";
import { addWorkingDays, DEFAULT_CALENDAR } from "./calendar";
import { PRESSURE_VESSEL_TOTAL_DAYS } from "./__fixtures__/pressure-vessel-v1";
import { isAppError, ERROR_CODES } from "@/lib/shared/errors";

function d(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

describe("checkFeasibility — the DE0467 regression case (BUILD-SPEC-v2 §1.5)", () => {
  /**
   * DE0467: PO 2026-06-24, committed dispatch 2026-10-15, 6-day calendar
   * week. BUILD-SPEC-v2 §1.5 and IMPLEMENTATION-GUIDE Step 7 both originally
   * asserted this comes out short by "~26 working days" — that figure is
   * arithmetically wrong. The correct count: 113 calendar days between the
   * two dates, less 16 Sundays, is 97 working days available; 119 (the
   * standard envelope) minus 97 is 22, not 26. Both docs were corrected to
   * 22 alongside this engine (see progress.md and the docs' own diffs) —
   * the engine reports the right number rather than being bent to match a
   * wrong one, per this project's own instruction not to "improvise past
   * invariant #10/#11 on a plausible-looking implementation."
   */
  it("is INFEASIBLE, short by exactly 22 working days against the 119-day standard envelope", () => {
    const result = checkFeasibility(
      d("2026-06-24"),
      d("2026-10-15"),
      PRESSURE_VESSEL_TOTAL_DAYS, // min == max == 119 for PRESSURE_VESSEL v1's terminal process
      PRESSURE_VESSEL_TOTAL_DAYS,
      DEFAULT_CALENDAR,
    );
    expect(result.feasibility).toBe("INFEASIBLE");
    expect(result.availableWorkingDays).toBe(97);
    expect(result.shortfallDays).toBe(22);
  });
});

describe("checkFeasibility — FEASIBLE / TIGHT / INFEASIBLE boundaries", () => {
  // A synthetic min/max spread (20-30 days) to exercise the TIGHT branch,
  // which PRESSURE_VESSEL v1's own min==max==119 terminal process cannot.
  const cases: {
    name: string;
    availableDays: number; // working days between an arbitrary PO/delivery pair
    expected: "FEASIBLE" | "TIGHT" | "INFEASIBLE";
    shortfallDays: number | null;
  }[] = [
    { name: "available exceeds the max — comfortably FEASIBLE", availableDays: 35, expected: "FEASIBLE", shortfallDays: null },
    { name: "available exactly equals the max — FEASIBLE (boundary is inclusive)", availableDays: 30, expected: "FEASIBLE", shortfallDays: null },
    { name: "available is between min and max — TIGHT, needs compression", availableDays: 25, expected: "TIGHT", shortfallDays: null },
    { name: "available exactly equals the min — TIGHT (boundary is inclusive)", availableDays: 20, expected: "TIGHT", shortfallDays: null },
    { name: "available is below the min — INFEASIBLE", availableDays: 15, expected: "INFEASIBLE", shortfallDays: 15 },
  ];

  it.each(cases)("$name", ({ availableDays, expected, shortfallDays }) => {
    // 6-day week: `availableDays` working days is availableDays + floor(availableDays/6) calendar days, roughly.
    // Simpler and exact: build the window with addWorkingDays from a fixed PO date via workingDaysBetween's own
    // inverse relationship, proven in calendar.test.ts — walk forward availableDays working days from the PO date.
    const po = d("2026-01-05"); // Monday, a working day
    const delivery = addWorkingDays(po, availableDays, DEFAULT_CALENDAR);
    const result = checkFeasibility(po, delivery, 20, 30, DEFAULT_CALENDAR);
    expect(result.feasibility).toBe(expected);
    expect(result.shortfallDays).toBe(shortfallDays);
  });
});

describe("checkFeasibility — input validation", () => {
  // AUD-035: this used to throw a bare `Error` — an unexplained 500 with no
  // application-level recovery path, since the caller had no stable code to
  // branch on. It must now be a real AppError (invariant #12).
  it("rejects requiredMinDays greater than requiredMaxDays with a stable AppError, not a bare Error", () => {
    const err = (() => {
      try {
        checkFeasibility(d("2026-01-01"), d("2026-02-01"), 30, 20, DEFAULT_CALENDAR);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(isAppError(err)).toBe(true);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.SCHEDULE_ENVELOPE_INVALID);
    expect(isAppError(err) && err.detail).toEqual({ requiredMinDays: 30, requiredMaxDays: 20 });
  });
});
