import { describe, expect, it } from "vitest";
import { collapseUnitPlans, isRiskyMix, JOB_GRAIN_PROCESS_CODES, predecessorStatus, type CollapsiblePlan } from "./job-grain";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const plan = (id: number, status: CollapsiblePlan["status"], extra: Partial<CollapsiblePlan> = {}): CollapsiblePlan => ({
  id, status, actualStart: null, actualFinish: null, reportedStartAt: null, reportedFinishAt: null, submittedBy: null, verifiedBy: null, ...extra,
});

describe("JOB_GRAIN_PROCESS_CODES", () => {
  it("is processes 1-11 and 33 (D5)", () => {
    expect(JOB_GRAIN_PROCESS_CODES).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "33"]);
  });
});

describe("collapseUnitPlans", () => {
  const table: Array<[string, CollapsiblePlan[], string]> = [
    ["all not started", [plan(1, "NOT_STARTED"), plan(2, "NOT_STARTED")], "NOT_STARTED"],
    ["all complete", [plan(1, "COMPLETE"), plan(2, "COMPLETE")], "COMPLETE"],
    ["all in progress", [plan(1, "IN_PROGRESS"), plan(2, "IN_PROGRESS")], "IN_PROGRESS"],
    ["all submitted by the same person", [plan(1, "SUBMITTED", { submittedBy: 7 }), plan(2, "SUBMITTED", { submittedBy: 7 })], "SUBMITTED"],
    ["submitted by different people: back to IN_PROGRESS (no maker may verify their own work)", [plan(1, "SUBMITTED", { submittedBy: 7 }), plan(2, "SUBMITTED", { submittedBy: 8 })], "IN_PROGRESS"],
    ["submitted with no recorded maker: back to IN_PROGRESS", [plan(1, "SUBMITTED", { submittedBy: 7 }), plan(2, "SUBMITTED")], "IN_PROGRESS"],
    ["some complete, some not started: not complete", [plan(1, "COMPLETE"), plan(2, "NOT_STARTED")], "IN_PROGRESS"],
    ["one started", [plan(1, "NOT_STARTED"), plan(2, "IN_PROGRESS")], "IN_PROGRESS"],
    ["a submitted mix is flattened", [plan(1, "SUBMITTED"), plan(2, "COMPLETE")], "IN_PROGRESS"],
    ["no plans", [], "NOT_STARTED"],
  ];
  it.each(table)("%s", (_n, plans, want) => expect(collapseUnitPlans(plans).status).toBe(want));

  it("takes the earliest start and, only when complete, the latest finish", () => {
    const c = collapseUnitPlans([
      plan(1, "COMPLETE", { actualStart: d("2026-10-05"), actualFinish: d("2026-10-09"), reportedStartAt: d("2026-10-04"), reportedFinishAt: d("2026-10-08"), verifiedBy: 9 }),
      plan(2, "COMPLETE", { actualStart: d("2026-10-03"), actualFinish: d("2026-10-12"), reportedFinishAt: d("2026-10-11") }),
    ]);
    expect(c).toMatchObject({ actualStart: d("2026-10-03"), actualFinish: d("2026-10-12"), reportedStartAt: d("2026-10-04"), reportedFinishAt: d("2026-10-11"), verifiedBy: 9 });
    const open = collapseUnitPlans([plan(1, "COMPLETE", { actualStart: d("2026-10-05"), actualFinish: d("2026-10-09") }), plan(2, "IN_PROGRESS", { actualStart: d("2026-10-06") })]);
    expect(open).toMatchObject({ status: "IN_PROGRESS", actualStart: d("2026-10-05"), actualFinish: null, verifiedBy: null });
  });

  it("keeps the one maker of a submitted plan, so maker-checker still has a maker; drops it when it flattens to IN_PROGRESS", () => {
    expect(collapseUnitPlans([plan(2, "SUBMITTED", { submittedBy: 4 }), plan(1, "SUBMITTED", { submittedBy: 4 })])).toMatchObject({ status: "SUBMITTED", submittedBy: 4 });
    expect(collapseUnitPlans([plan(2, "SUBMITTED", { submittedBy: 7 }), plan(1, "SUBMITTED", { submittedBy: 4 })])).toMatchObject({ status: "IN_PROGRESS", submittedBy: null });
  });
});

describe("isRiskyMix", () => {
  it.each([
    [["SUBMITTED", "COMPLETE"], true],
    [["ON_HOLD", "IN_PROGRESS"], true],
    [["SUBMITTED", "SUBMITTED"], false], // same maker (7) on both
    [["COMPLETE", "NOT_STARTED"], false],
    [["IN_PROGRESS"], false],
  ] as const)("%j -> %s", (statuses, want) => expect(isRiskyMix(statuses.map((status) => ({ status, submittedBy: 7 })))).toBe(want));

  it("all submitted, but by different people or with no recorded maker, is risky: it cannot stay SUBMITTED", () => {
    expect(isRiskyMix([{ status: "SUBMITTED", submittedBy: 7 }, { status: "SUBMITTED", submittedBy: 8 }])).toBe(true);
    expect(isRiskyMix([{ status: "SUBMITTED", submittedBy: 7 }, { status: "SUBMITTED", submittedBy: null }])).toBe(true);
  });
});

describe("predecessorStatus", () => {
  const units = [{ unitId: 1, status: "COMPLETE" as const }, { unitId: 2, status: "IN_PROGRESS" as const }];
  it("a unit reads its own plan", () => {
    expect(predecessorStatus(units, 1)).toBe("COMPLETE");
    expect(predecessorStatus(units, 2)).toBe("IN_PROGRESS");
  });
  it("a unit with no plan of its own reads the job-level plan, else NOT_STARTED", () => {
    expect(predecessorStatus([{ unitId: null, status: "COMPLETE" }], 3)).toBe("COMPLETE");
    expect(predecessorStatus(units, 3)).toBe("NOT_STARTED");
    expect(predecessorStatus([], 1)).toBe("NOT_STARTED");
  });
  it("a unit's own plan wins over the job-level one", () => {
    expect(predecessorStatus([{ unitId: null, status: "COMPLETE" }, { unitId: 1, status: "NOT_STARTED" }], 1)).toBe("NOT_STARTED");
  });
  it("a job-level plan waits for the least advanced unit", () => {
    expect(predecessorStatus(units, null)).toBe("IN_PROGRESS");
    expect(predecessorStatus([...units, { unitId: 3, status: "NOT_STARTED" }], null)).toBe("NOT_STARTED");
    expect(predecessorStatus([{ unitId: 1, status: "COMPLETE" }, { unitId: 2, status: "SUBMITTED" }], null)).toBe("SUBMITTED");
  });
  it("a job-level plan reads a job-level predecessor directly", () => {
    expect(predecessorStatus([{ unitId: null, status: "SUBMITTED" }], null)).toBe("SUBMITTED");
  });
});
