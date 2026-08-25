import { expect, test } from "vitest";
import { planFillStatus, computeGanttDomain, computeDepartmentDeadlines, ganttPct } from "./gantt-layout";
import type { GanttBar, GanttUnit } from "./gantt-layout";

// ── planFillStatus — the row-level §11.2 ladder for a single plan ─────────

test.each([
  ["ON_HOLD", false, "hold"],
  ["ON_HOLD", true, "hold"], // hold outranks overdue, mirrors the stage-level ladder
  ["IN_PROGRESS", true, "overdue"],
  ["SUBMITTED", true, "overdue"],
  ["SUBMITTED", false, "submitted"],
  ["IN_PROGRESS", false, "progress"],
  ["COMPLETE", false, "complete"],
  ["COMPLETE", true, "complete"], // complete plans are never "overdue" (checked first)
  ["NOT_STARTED", false, "idle"],
] as const)("planFillStatus(%s, overdue=%s) → %s", (status, overdue, expected) => {
  expect(planFillStatus(status, overdue)).toBe(expected);
});

// ── computeGanttDomain / ganttPct — bar layout math ────────────────────────

function bar(overrides: Partial<GanttBar> = {}): GanttBar {
  return {
    jobProcessId: 1,
    code: "P1",
    name: "Test process",
    seq: 1,
    stageNo: 1,
    deptName: "Test",
    status: "NOT_STARTED",
    overdue: false,
    plannedStart: null,
    plannedFinish: null,
    actualStart: null,
    actualFinish: null,
    standardDays: null,
    ...overrides,
  };
}

const NOW = "2026-08-15T00:00:00.000Z";

test("no dated bars → 1-day fallback window around now", () => {
  const domain = computeGanttDomain([bar()], NOW);
  expect(domain.end - domain.start).toBe(86400000);
  expect(domain.start).toBe(new Date(NOW).getTime());
});

test("domain spans the earliest planned start to the latest planned finish", () => {
  const bars = [
    bar({ plannedStart: "2026-06-01T00:00:00.000Z", plannedFinish: "2026-06-10T00:00:00.000Z" }),
    bar({ plannedStart: "2026-07-01T00:00:00.000Z", plannedFinish: "2026-09-01T00:00:00.000Z" }),
  ];
  const domain = computeGanttDomain(bars, NOW); // NOW (Aug 15) falls inside the bars' range — doesn't move either edge
  expect(domain.start).toBe(new Date("2026-06-01T00:00:00.000Z").getTime());
  expect(domain.end).toBe(new Date("2026-09-01T00:00:00.000Z").getTime());
});

test("domain always includes now, even if every bar is in the past", () => {
  const bars = [bar({ plannedStart: "2026-01-01T00:00:00.000Z", plannedFinish: "2026-01-10T00:00:00.000Z" })];
  const domain = computeGanttDomain(bars, NOW);
  expect(domain.end).toBe(new Date(NOW).getTime());
});

test("domain does NOT pull start back to now when the whole schedule is still in the future (DESPL-320's own case: today is months before the real order date)", () => {
  const bars = [bar({ plannedStart: "2026-11-20T00:00:00.000Z", plannedFinish: "2027-04-08T00:00:00.000Z" })];
  const domain = computeGanttDomain(bars, NOW); // NOW (Aug 15) is well before the schedule starts
  expect(domain.start).toBe(new Date("2026-11-20T00:00:00.000Z").getTime());
  expect(domain.end).toBe(new Date("2027-04-08T00:00:00.000Z").getTime());
});

test("ganttPct: null date → null", () => {
  expect(ganttPct(null, { start: 0, end: 100 })).toBeNull();
});

test("ganttPct: midpoint date → 50", () => {
  const domain = { start: new Date("2026-06-01T00:00:00.000Z").getTime(), end: new Date("2026-06-03T00:00:00.000Z").getTime() };
  expect(ganttPct("2026-06-02T00:00:00.000Z", domain)).toBe(50);
});

test("ganttPct: domain start/end → 0/100", () => {
  const domain = { start: new Date("2026-06-01T00:00:00.000Z").getTime(), end: new Date("2026-06-05T00:00:00.000Z").getTime() };
  expect(ganttPct("2026-06-01T00:00:00.000Z", domain)).toBe(0);
  expect(ganttPct("2026-06-05T00:00:00.000Z", domain)).toBe(100);
});

// ── computeDepartmentDeadlines — job-level rollup across every unit ────────

function unit(serialNo: string, bars: GanttBar[]): GanttUnit {
  return { unitId: Number(serialNo), serialNo, bars };
}

test("computeDepartmentDeadlines: one row per department, earliest start to latest finish across all units", () => {
  const units: GanttUnit[] = [
    unit("SR01", [
      bar({ jobProcessId: 1, seq: 1, deptName: "Projects / PMO", plannedStart: "2026-11-20T00:00:00.000Z", plannedFinish: "2026-11-23T00:00:00.000Z" }),
      bar({ jobProcessId: 12, seq: 12, deptName: "Fabrication Prep", plannedStart: "2027-02-05T00:00:00.000Z", plannedFinish: "2027-02-10T00:00:00.000Z" }),
    ]),
    unit("SR02", [
      bar({ jobProcessId: 1, seq: 1, deptName: "Projects / PMO", plannedStart: "2026-11-20T00:00:00.000Z", plannedFinish: "2026-11-23T00:00:00.000Z" }),
      // A later-staggered unit's Fabrication Prep pushes the department's own-work-done-by date out.
      bar({ jobProcessId: 12, seq: 12, deptName: "Fabrication Prep", plannedStart: "2027-02-12T00:00:00.000Z", plannedFinish: "2027-02-17T00:00:00.000Z" }),
    ]),
  ];
  const result = computeDepartmentDeadlines(units);
  expect(result).toEqual([
    { deptName: "Projects / PMO", firstStartsBy: "2026-11-20T00:00:00.000Z", ownWorkDoneBy: "2026-11-23T00:00:00.000Z", processCount: 1 },
    { deptName: "Fabrication Prep", firstStartsBy: "2027-02-05T00:00:00.000Z", ownWorkDoneBy: "2027-02-17T00:00:00.000Z", processCount: 1 },
  ]);
});

test("computeDepartmentDeadlines: sorted by first-starts-by, matching the envelope order", () => {
  const units: GanttUnit[] = [
    unit("SR01", [
      bar({ jobProcessId: 36, seq: 36, deptName: "Dispatch & Logistics", plannedStart: "2027-04-07T00:00:00.000Z", plannedFinish: "2027-04-08T00:00:00.000Z" }),
      bar({ jobProcessId: 1, seq: 1, deptName: "Projects / PMO", plannedStart: "2026-11-20T00:00:00.000Z", plannedFinish: "2026-11-23T00:00:00.000Z" }),
    ]),
  ];
  const result = computeDepartmentDeadlines(units);
  expect(result.map((d) => d.deptName)).toEqual(["Projects / PMO", "Dispatch & Logistics"]);
});

test("computeDepartmentDeadlines: distinct process count per department, not per-unit row count", () => {
  const units: GanttUnit[] = [
    unit("SR01", [
      bar({ jobProcessId: 14, code: "P14", seq: 14, deptName: "QC", plannedStart: "2027-02-08T00:00:00.000Z", plannedFinish: "2027-02-09T00:00:00.000Z" }),
      bar({ jobProcessId: 22, code: "P22", seq: 22, deptName: "QC", plannedStart: "2027-03-01T00:00:00.000Z", plannedFinish: "2027-03-02T00:00:00.000Z" }),
    ]),
    unit("SR02", [
      bar({ jobProcessId: 14, code: "P14", seq: 14, deptName: "QC", plannedStart: "2027-02-08T00:00:00.000Z", plannedFinish: "2027-02-09T00:00:00.000Z" }),
      bar({ jobProcessId: 22, code: "P22", seq: 22, deptName: "QC", plannedStart: "2027-03-01T00:00:00.000Z", plannedFinish: "2027-03-02T00:00:00.000Z" }),
    ]),
  ];
  const result = computeDepartmentDeadlines(units);
  expect(result).toEqual([{ deptName: "QC", firstStartsBy: "2027-02-08T00:00:00.000Z", ownWorkDoneBy: "2027-03-02T00:00:00.000Z", processCount: 2 }]);
});

test("computeDepartmentDeadlines: no units → empty list", () => {
  expect(computeDepartmentDeadlines([])).toEqual([]);
});
