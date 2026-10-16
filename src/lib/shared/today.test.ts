import { describe, expect, it } from "vitest";
import { buildCheckIn, endOfIstDay, sectionize, type SectionRow } from "./today";

const NOW = new Date("2026-10-15T09:30:00+05:30");
const row = (key: string, over: Partial<SectionRow> = {}): SectionRow => ({
  key,
  title: key,
  state: "READY",
  dueAt: "2026-10-15T12:00:00+05:30",
  lateReasonNeeded: false,
  canOverride: false,
  ...over,
});

describe("endOfIstDay", () => {
  it("is the next IST midnight, whatever the UTC date", () => {
    expect(endOfIstDay(new Date("2026-10-15T09:30:00+05:30")).toISOString()).toBe("2026-10-15T18:30:00.000Z");
    // 00:10 IST on the 16th is still the 15th in UTC
    expect(endOfIstDay(new Date("2026-10-16T00:10:00+05:30")).toISOString()).toBe("2026-10-16T18:30:00.000Z");
  });
});

describe("sectionize", () => {
  it("puts due-today and in-progress rows in Today, later ones in Upcoming, hard stops in Blocked", () => {
    const s = sectionize(
      [
        row("due", { dueAt: "2026-10-15T17:00:00+05:30" }),
        row("late", { dueAt: "2026-10-12T00:00:00+05:30" }),
        row("started-later", { state: "IN_PROGRESS", dueAt: "2026-10-20T00:00:00+05:30" }),
        row("future", { dueAt: "2026-10-17T00:00:00+05:30" }),
        row("unscheduled", { dueAt: null }),
        row("stop", { state: "BLOCKED" }),
      ],
      NOW,
    );
    expect(s.doFirst?.key).toBe("stop"); // no late-with-reason row, so blocked comes first
    expect(s.today.map((r) => r.key)).toEqual(["started-later", "late", "due"]);
    expect(s.upcoming.map((r) => r.key)).toEqual(["future", "unscheduled"]);
    expect(s.blocked).toEqual([]);
  });

  it("Do this first: late with a reason owed, then blocked, then due today", () => {
    const rows = [
      row("a-due"),
      row("b-blocked", { state: "BLOCKED" }),
      row("c-late", { lateReasonNeeded: true, dueAt: "2026-10-10T00:00:00+05:30" }),
    ];
    expect(sectionize(rows, NOW).doFirst?.key).toBe("c-late");
    expect(sectionize(rows.slice(0, 2), NOW).doFirst?.key).toBe("b-blocked");
    expect(sectionize(rows.slice(0, 1), NOW).doFirst?.key).toBe("a-due");
    expect(sectionize([], NOW).doFirst).toBeNull();
  });

  it("an out-of-order row is Blocked for an operator, workable for a supervisor", () => {
    const early = row("early", { state: "NEEDS_OVERRIDE" });
    const op = sectionize([row("x"), early], NOW);
    expect([op.doFirst, ...op.blocked].map((r) => r?.key)).toContain("early");
    expect(op.today.map((r) => r.key)).toEqual(["x"]);
    expect(op.summary.blocked).toBe(1);
    const sup = sectionize([row("x", { dueAt: "2026-10-20T00:00:00+05:30" }), { ...early, canOverride: true }], NOW);
    expect(sup.blocked).toEqual([]);
    expect([sup.doFirst?.key, ...sup.today.map((r) => r.key)]).toContain("early");
  });

  it("rows already with QC are not mine to do and are left out", () => {
    const s = sectionize([row("q", { state: "WITH_QC" }), row("i", { state: "QC_STEP" }), row("r")], NOW);
    expect(s.summary.assigned).toBe(1);
  });

  it("the summary counts always add up to the sections", () => {
    const rows = [
      row("1", { lateReasonNeeded: true }),
      row("2"),
      row("3", { state: "IN_PROGRESS" }),
      row("4", { state: "BLOCKED" }),
      row("5", { state: "BLOCKED" }),
      row("6", { dueAt: "2026-11-01T00:00:00+05:30" }),
    ];
    const s = sectionize(rows, NOW);
    const sections = (s.doFirst ? 1 : 0) + s.today.length + s.blocked.length + s.upcoming.length;
    expect(s.summary.assigned).toBe(sections);
    expect(s.summary.assigned).toBe(6);
    expect(s.summary.blocked).toBe(2);
    expect(s.summary.dueToday + s.summary.blocked + s.upcoming.length).toBe(s.summary.assigned);
    expect(s.summary.needsAttention).toBe(1);
  });
});

describe("buildCheckIn", () => {
  const rows = [
    { key: "S:1", kind: "ASSEMBLY_STEP" as const, id: 1, jobId: 10, planId: 100, alreadyDone: false },
    { key: "S:2", kind: "ASSEMBLY_STEP" as const, id: 2, jobId: 10, planId: 100, alreadyDone: false },
    { key: "O:3", kind: "COMPONENT_OP" as const, id: 3, jobId: 11, planId: 101, alreadyDone: false },
    { key: "S:4", kind: "ASSEMBLY_STEP" as const, id: 4, jobId: 10, planId: null, alreadyDone: false },
    { key: "S:5", kind: "ASSEMBLY_STEP" as const, id: 5, jobId: 10, planId: 100, alreadyDone: true },
  ];

  it("posts only the rows the person changed, one batch per job", () => {
    const plan = buildCheckIn(rows, { "S:1": "DONE", "O:3": "DONE", "S:2": undefined });
    expect(plan.done).toEqual([
      { jobId: 10, items: [{ kind: "ASSEMBLY_STEP", id: 1 }] },
      { jobId: 11, items: [{ kind: "COMPONENT_OP", id: 3 }] },
    ]);
    expect(plan.notDonePlanIds).toEqual([]);
  });

  it("not-done files one reason per plan; a row with no plan is reported, not dropped", () => {
    const plan = buildCheckIn(rows, { "S:1": "NOT_DONE", "S:2": "NOT_DONE", "S:4": "NOT_DONE" });
    expect(plan.notDonePlanIds).toEqual([100]);
    expect(plan.notDoneWithoutPlan).toEqual(["S:4"]);
    expect(plan.done).toEqual([]);
  });

  it("a row already done today is never re-posted, whatever the choice says", () => {
    const plan = buildCheckIn(rows, { "S:5": "DONE" });
    expect(plan.done).toEqual([]);
  });

  it("nothing chosen posts nothing", () => {
    expect(buildCheckIn(rows, {})).toEqual({ done: [], notDonePlanIds: [], notDoneWithoutPlan: [] });
  });
});
