import { expect, test } from "vitest";
import { planFillStatus, computeGanttDomain, ganttPct } from "./gantt-layout";
import type { GanttBar } from "./gantt-layout";

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
