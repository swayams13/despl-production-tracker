import { describe, expect, it } from "vitest";
import { isAckStale, reviewPairs, staleAcksByJob, type PairOverride } from "./override-review";

// 2027-02-08 is a Monday; Sunday (weekOffDays [7]) is off by default.
const at = (iso: string) => new Date(`${iso}+05:30`);

describe("isAckStale: 2 working days on the 6-day week", () => {
  it.each([
    ["Mon 10:00 -> Wed 09:59 is not yet", "2027-02-08T10:00:00", "2027-02-10T09:59:00", false],
    ["Mon 10:00 -> Wed 10:00 is stale", "2027-02-08T10:00:00", "2027-02-10T10:00:00", true],
    ["Sat 10:00 -> Mon 10:00 is not (Sunday does not count)", "2027-02-06T10:00:00", "2027-02-08T10:00:00", false],
    ["Sat 10:00 -> Tue 10:00 is stale", "2027-02-06T10:00:00", "2027-02-09T10:00:00", true],
    ["a minute ago is not", "2027-02-10T09:59:00", "2027-02-10T10:00:00", false],
  ])("%s", (_l, created, now, want) => {
    expect(isAckStale(at(created), at(now))).toBe(want);
  });

  it("a calendar that also takes Saturday off pushes the digest line out", () => {
    const fiveDay = { weekOffDays: [6, 7], holidays: [] };
    // Fri 10:00 -> Tue 09:00: 47 working hours on a 5-day week, but Saturday counts on the default 6-day week.
    expect(isAckStale(at("2027-02-05T10:00:00"), at("2027-02-09T09:00:00"), fiveDay)).toBe(false);
    expect(isAckStale(at("2027-02-05T10:00:00"), at("2027-02-09T09:00:00"))).toBe(true);
  });
});

describe("staleAcksByJob: one line per job", () => {
  const now = at("2027-02-12T08:30:00");
  const cal = new Map();
  it("counts only stale rows, keeps the oldest, orders by count", () => {
    const lines = staleAcksByJob(
      [
        { jobId: 1, jobNumber: "J1", createdAt: at("2027-02-09T10:00:00") },
        { jobId: 1, jobNumber: "J1", createdAt: at("2027-02-08T10:00:00") },
        { jobId: 1, jobNumber: "J1", createdAt: at("2027-02-12T07:00:00") }, // fresh
        { jobId: 2, jobNumber: "J2", createdAt: at("2027-02-09T10:00:00") },
        { jobId: 2, jobNumber: "J2", createdAt: at("2027-02-09T11:00:00") },
        { jobId: 2, jobNumber: "J2", createdAt: at("2027-02-09T12:00:00") },
        { jobId: 3, jobNumber: "J3", createdAt: at("2027-02-12T08:00:00") }, // fresh only: no line
      ],
      now,
      cal,
    );
    expect(lines).toEqual([
      { jobNumber: "J2", count: 3, oldestAt: at("2027-02-09T10:00:00").toISOString() },
      { jobNumber: "J1", count: 2, oldestAt: at("2027-02-08T10:00:00").toISOString() },
    ]);
  });
  it("nothing waiting, no lines", () => expect(staleAcksByJob([], now, cal)).toEqual([]));
});

describe("reviewPairs: >= half of a job's units, minimum 3", () => {
  const row = (jobId: number, unitId: number | null, step = "A", skipped = "B"): PairOverride => ({ jobId, unitId, step, skipped });
  const units = (n: number, o: Partial<PairOverride> = {}) => Array.from({ length: n }, (_, i) => ({ ...row(1, i + 1), ...o }));

  it.each([
    ["2 of 2 units is under the minimum", units(2), 2, 0],
    ["2 of 4 units is under the minimum", units(2), 4, 0],
    ["3 of 6 units is exactly half", units(3), 6, 1],
    ["3 of 7 units is under half", units(3), 7, 0],
    ["4 of 7 units is over half", units(4), 7, 1],
    ["9 of 9 units", units(9), 9, 1],
  ])("%s", (_l, rows, total, want) => {
    expect(reviewPairs(rows, new Map([[1, total]]))).toHaveLength(want);
  });

  it("counts a unit once however many times the pair was overridden on it", () => {
    expect(reviewPairs([...units(2), row(1, 1), row(1, 2)], new Map([[1, 3]]))).toHaveLength(0);
  });
  it("ignores overrides with no unit, and keeps pairs, directions and jobs apart", () => {
    const rows = [...units(3), ...units(3, { step: "B", skipped: "A" }), ...units(3, { jobId: 2 }), row(1, null), row(1, null), row(1, null)];
    const out = reviewPairs(rows, new Map([[1, 4], [2, 3]]));
    expect(out.map((p) => [p.jobId, p.step, p.skipped, p.units, p.totalUnits])).toEqual([
      [2, "A", "B", 3, 3],
      [1, "A", "B", 3, 4],
      [1, "B", "A", 3, 4],
    ]);
  });
  it("a job with an unknown unit count never flags", () => {
    expect(reviewPairs(units(3), new Map())).toEqual([]);
  });
});
