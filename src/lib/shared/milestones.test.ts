import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { D9_MILESTONES, PV_MILESTONE_MAP, milestoneLabel, planEffort, portfolioMilestoneText, rollupMilestones, type MilestonePlanFact } from "./milestones";

const defs = D9_MILESTONES.map((d, i) => ({ id: i + 1, code: d.code, name: d.name, sortOrder: (i + 1) * 10 }));
const id = (code: string) => defs.find((d) => d.code === code)!.id;
const pvMap = new Map(Object.entries(PV_MILESTONE_MAP).map(([k, v]) => [k, { milestoneId: id(v), weight: null }]));
const now = new Date("2026-11-10T00:00:00Z");
const plan = (processCode: string, status: MilestonePlanFact["status"], durationDays: number | null = 10, finish: string | null = "2026-12-01"): MilestonePlanFact => ({
  processCode,
  durationDays,
  status,
  plannedFinish: finish ? new Date(finish) : null,
});

describe("J8 PV milestone map", () => {
  it("covers every one of the 36 lead-time processes exactly once, with D9's ten names", () => {
    const model = JSON.parse(readFileSync("seed/lead-time-model.json", "utf8")) as { processes: { code: number }[] };
    expect(Object.keys(PV_MILESTONE_MAP).sort((a, b) => Number(a) - Number(b))).toEqual(model.processes.map((p) => String(p.code)));
    expect(defs.map((d) => d.name)).toEqual([
      "Engineering approved", "Material ready", "Cutting & forming", "Fabrication", "NDT", "PWHT", "Pressure test", "Painting", "Documentation", "Dispatched",
    ]);
    expect(new Set(Object.values(PV_MILESTONE_MAP))).toEqual(new Set(defs.map((d) => d.code)));
  });
});

describe("rollupMilestones", () => {
  it("weights by planned effort: a 30-day plan outweighs a 10-day plan", () => {
    const r = rollupMilestones(defs, pvMap, [plan("15", "COMPLETE", 10), plan("16", "IN_PROGRESS", 30)], now);
    expect(r.milestones.map((m) => [m.code, m.percent, m.state])).toEqual([["FAB", 25, "IN_PROGRESS"]]);
  });

  it("a mapping weight overrides the duration; a provisional (null) duration counts as 1", () => {
    expect(planEffort({ milestoneId: 1, weight: 5 }, 30)).toBe(5);
    expect(planEffort({ milestoneId: 1, weight: null }, null)).toBe(1);
    expect(planEffort({ milestoneId: 1, weight: null }, 0)).toBe(1);
  });

  it("counts one plan per unit, so a milestone over nine units is effort x 9", () => {
    const plans = Array.from({ length: 9 }, (_, i) => plan("21", i < 3 ? "COMPLETE" : "NOT_STARTED", 10));
    const m = rollupMilestones(defs, pvMap, plans, now).milestones[0];
    expect([m.code, m.plans, m.donePlans, m.percent, m.state]).toEqual(["PWHT", 9, 3, 33, "IN_PROGRESS"]);
  });

  it("SUBMITTED and ON_HOLD earn no credit but mark the milestone started", () => {
    const m = rollupMilestones(defs, pvMap, [plan("17", "SUBMITTED"), plan("22", "NOT_STARTED")], now).milestones[0];
    expect([m.percent, m.state]).toEqual([0, "IN_PROGRESS"]);
  });

  it("picks the first incomplete milestone in order as current, and lists only milestones the job has", () => {
    const r = rollupMilestones(defs, pvMap, [plan("1", "COMPLETE"), plan("7", "COMPLETE"), plan("12", "IN_PROGRESS"), plan("36", "NOT_STARTED")], now);
    expect(r.milestones.map((m) => m.code)).toEqual(["ENG", "MAT", "CUT", "DISP"]);
    expect(r.current?.code).toBe("CUT");
  });

  it("current is null when every listed milestone is complete or none is listed", () => {
    expect(rollupMilestones(defs, pvMap, [plan("1", "COMPLETE")], now).current).toBeNull();
    expect(rollupMilestones(defs, pvMap, [], now)).toEqual({ milestones: [], current: null, unmappedPlans: 0 });
  });

  it("planned finish is the latest mapped plan; late only while incomplete and past it", () => {
    const r = rollupMilestones(defs, pvMap, [plan("15", "NOT_STARTED", 10, "2026-11-05"), plan("16", "NOT_STARTED", 10, "2026-12-20"), plan("17", "NOT_STARTED", 10, null)], now);
    const fab = r.milestones.find((m) => m.code === "FAB")!;
    expect([fab.plannedFinish, fab.late]).toEqual(["2026-12-20", false]);
    const done = rollupMilestones(defs, pvMap, [plan("1", "COMPLETE", 10, "2026-11-01")], now).milestones[0];
    expect(done.late).toBe(false);
    const late = rollupMilestones(defs, pvMap, [plan("1", "IN_PROGRESS", 10, "2026-11-01")], now).milestones[0];
    expect(late.late).toBe(true);
  });

  it("counts plans whose process code the map does not cover instead of dropping them silently", () => {
    expect(rollupMilestones(defs, pvMap, [plan("999", "COMPLETE"), plan("1", "COMPLETE")], now).unmappedPlans).toBe(1);
  });

  it("formats the Portfolio cell", () => {
    expect(milestoneLabel({ name: "Fabrication", percent: 40 })).toBe("Fabrication 40%");
    const cur = rollupMilestones(defs, pvMap, [plan("15", "IN_PROGRESS")], now).current;
    expect(portfolioMilestoneText({ currentMilestone: cur, milestonesComplete: false })).toBe("Fabrication 0%");
    expect(portfolioMilestoneText({ currentMilestone: null, milestonesComplete: true })).toBe("All milestones done");
    expect(portfolioMilestoneText({ currentMilestone: null, milestonesComplete: false })).toBeNull();
  });
});
