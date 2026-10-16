import { describe, expect, it } from "vitest";
import { leastLoadedFirst, oldestLabel, sameDayRate, summarizeTeam, type TeamPlanFact } from "./team";

const NOW = new Date("2026-10-15T10:00:00+05:30");
const plan = (id: number, over: Partial<TeamPlanFact> = {}): TeamPlanFact => ({
  planId: id,
  assigneeId: 1,
  state: "READY",
  overdue: false,
  dueAt: "2026-10-20T12:00:00+05:30",
  ...over,
});

describe("oldestLabel", () => {
  it.each<[string, Array<string | null>, string]>([
    ["two IST days late", ["2026-10-13T20:00:00+05:30", "2026-10-19T00:00:00+05:30"], "2 d"],
    ["due today", ["2026-10-15T17:00:00+05:30"], "today"],
    ["only in the future", ["2026-10-20T00:00:00+05:30"], "—"],
    ["nothing scheduled", [null], "—"],
    ["empty", [], "—"],
  ])("%s", (_l, dues, out) => expect(oldestLabel(dues, NOW)).toBe(out));
});

describe("summarizeTeam", () => {
  const members = [
    { userId: 1, name: "Anil" },
    { userId: 2, name: "Imran" },
    { userId: 3, name: "Deepak" },
  ];
  const plans = [
    plan(1, { assigneeId: 1, overdue: true, dueAt: "2026-10-13T00:00:00+05:30" }),
    plan(2, { assigneeId: 1, dueAt: "2026-10-15T17:00:00+05:30" }),
    plan(3, { assigneeId: 1, state: "BLOCKED" }),
    plan(4, { assigneeId: 2, dueAt: "2026-10-15T09:00:00+05:30" }),
    plan(5, { assigneeId: null }),
    plan(6, { assigneeId: null, overdue: true, dueAt: "2026-10-12T00:00:00+05:30" }),
    plan(7, { assigneeId: 2, state: "DONE" }),
  ];
  const s = summarizeTeam(plans, members, NOW);

  it("open is assigned plus unassigned, and finished work is not open", () => {
    expect(s.open).toBe(6);
    expect(s.assigned + s.unassigned).toBe(s.open);
    expect(s).toMatchObject({ assigned: 4, unassigned: 2, overdue: 2, blocked: 1 });
  });

  it("one row per member, most overdue first; an idle member is flagged", () => {
    expect(s.people.map((p) => p.name)).toEqual(["Anil", "Imran", "Deepak"]);
    expect(s.people[0]).toMatchObject({ assigned: 3, overdue: 1, dueToday: 1, blocked: 1, oldest: "2 d", idle: false });
    expect(s.people[1]).toMatchObject({ assigned: 1, dueToday: 1, oldest: "today" });
    expect(s.people[2]).toMatchObject({ assigned: 0, idle: true, oldest: "—" });
  });

  it("work held by someone outside the roster still counts as assigned, not unassigned", () => {
    const t = summarizeTeam([plan(9, { assigneeId: 99 })], members, NOW);
    expect(t).toMatchObject({ open: 1, assigned: 1, unassigned: 0 });
  });
});

describe("leastLoadedFirst", () => {
  it("lists the idle person first, ties by name", () => {
    const out = leastLoadedFirst([
      { name: "Zed", assigned: 2 },
      { name: "Amy", assigned: 2 },
      { name: "Bob", assigned: 0 },
    ]);
    expect(out.map((p) => p.name)).toEqual(["Bob", "Amy", "Zed"]);
  });
});

describe("sameDayRate (D4 refinement 3: recordedAt vs reportedAt)", () => {
  const d = (s: string) => new Date(s);
  it("counts an update with no reported time, or reported the same IST day, as same-day", () => {
    const r = sameDayRate([
      { recordedAt: d("2026-10-15T09:00:00+05:30"), reportedAt: null },
      { recordedAt: d("2026-10-15T09:00:00+05:30"), reportedAt: d("2026-10-15T07:00:00+05:30") },
      { recordedAt: d("2026-10-15T09:00:00+05:30"), reportedAt: d("2026-10-14T16:00:00+05:30") }, // yesterday's work
    ]);
    expect(r).toEqual({ rate: 67, same: 2, total: 3 });
  });
  it("uses the IST day, not the UTC day", () => {
    // 00:30 IST on the 15th is still the 14th in UTC: same IST day as 23:00 IST the 14th? No, a different one.
    const r = sameDayRate([{ recordedAt: d("2026-10-15T00:30:00+05:30"), reportedAt: d("2026-10-14T23:00:00+05:30") }]);
    expect(r.rate).toBe(0);
    const s = sameDayRate([{ recordedAt: d("2026-10-15T00:30:00+05:30"), reportedAt: d("2026-10-15T00:05:00+05:30") }]);
    expect(s.rate).toBe(100);
  });
  it("no events is no rate, not zero", () => {
    expect(sameDayRate([])).toEqual({ rate: null, same: 0, total: 0 });
  });
});
