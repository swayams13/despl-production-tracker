import { describe, expect, it } from "vitest";
import {
  applyBoardFilter,
  boardFilterQuery,
  deriveCell,
  fmtDay,
  fmtLongDay,
  parseBoardFilter,
  planStatusWord,
  type CellFacts,
} from "./board";

const base: CellFacts = {
  status: "idle",
  hasPlans: true,
  rejected: false,
  doneAt: null,
  plannedAt: null,
  daysLate: null,
  itemsDone: 0,
  itemsTotal: 0,
  outOfSequence: false,
};

describe("deriveCell: the value printed in every cell (frame 03A)", () => {
  it.each<[string, Partial<CellFacts>, string]>([
    ["done prints its date", { status: "complete", doneAt: "2026-02-12T10:00:00+05:30" }, "12 Feb"],
    ["done with no date still prints", { status: "complete" }, "Done"],
    ["in progress prints steps done", { status: "progress", itemsDone: 3, itemsTotal: 7 }, "3/7"],
    ["in progress with nothing mapped says so", { status: "progress" }, "In prog."],
    ["waiting for QC", { status: "submitted" }, "QC"],
    ["hold", { status: "hold" }, "H"],
    ["overdue prints days late", { status: "overdue", daysLate: 2 }, "+2d"],
    ["overdue under a day", { status: "overdue", daysLate: 0 }, "late"],
    ["not started prints the planned date", { status: "idle", plannedAt: "2026-02-20T00:00:00+05:30" }, "20 Feb"],
    ["not started with no schedule", { status: "idle" }, "not sch."],
    ["no process at all is a dash", { hasPlans: false, status: "complete" }, "–"],
  ])("%s", (_l, facts, value) => {
    expect(deriveCell({ ...base, ...facts }).value).toBe(value);
  });

  it("rejection and out-of-sequence are markers, never a value", () => {
    const c = deriveCell({ ...base, status: "progress", itemsDone: 1, itemsTotal: 2, rejected: true, outOfSequence: true });
    expect(c).toMatchObject({ value: "1/2", rejected: true, outOfSequence: true });
    expect(c.label).toContain("rejected");
    expect(c.label).toContain("out of sequence");
  });

  it("a dash cell is idle whatever the rollup said", () => {
    expect(deriveCell({ ...base, hasPlans: false, status: "overdue" })).toMatchObject({ status: "idle", hasPlans: false });
  });
});

describe("dates", () => {
  it("print in IST", () => {
    expect(fmtDay("2026-02-11T20:00:00Z")).toBe("12 Feb"); // 01:30 IST next day
    expect(fmtLongDay("2026-11-20T00:00:00Z")).toBe("20-Nov-2026");
  });
});

describe("planStatusWord (the workbook's vocabulary)", () => {
  it.each([
    ["NOT_STARTED", false, "-"],
    ["IN_PROGRESS", false, "Started"],
    ["SUBMITTED", false, "Submitted"],
    ["ON_HOLD", false, "Hold"],
    ["COMPLETE", true, "Verified"],
    ["COMPLETE", false, "Complete"],
  ])("%s verified=%s -> %s", (status, verified, word) => {
    expect(planStatusWord(status, verified)).toBe(word);
  });
});

describe("filters", () => {
  it("round-trip through the URL and ignore junk", () => {
    const f = parseBoardFilter({ dept: "4", status: "hold", oos: "1", hide: "1" });
    expect(f).toEqual({ dept: 4, status: "hold", oos: true, hideDone: true });
    expect(boardFilterQuery(f)).toBe("?dept=4&status=hold&oos=1&hide=1");
    expect(parseBoardFilter({ dept: "x", status: "bogus", oos: "0" })).toEqual({ dept: null, status: null, oos: false, hideDone: false });
    expect(boardFilterQuery({ dept: null, status: null, oos: false, hideDone: false })).toBe("");
  });

  const shape = {
    stages: [
      { stageNo: 10, departmentId: 1 },
      { stageNo: 11, departmentId: 2 },
      { stageNo: 12, departmentId: 2 },
    ],
    units: [
      {
        unitId: 1,
        cells: {
          10: { status: "complete" as const, outOfSequence: false, hasPlans: true },
          11: { status: "hold" as const, outOfSequence: false, hasPlans: true },
          12: { status: "idle" as const, outOfSequence: true, hasPlans: true },
        },
      },
      {
        unitId: 2,
        cells: {
          10: { status: "complete" as const, outOfSequence: false, hasPlans: true },
          11: { status: "complete" as const, outOfSequence: false, hasPlans: true },
          12: { status: "progress" as const, outOfSequence: false, hasPlans: true },
        },
      },
    ],
  };
  const f = (over: Partial<ReturnType<typeof parseBoardFilter>>) => ({ dept: null, status: null, oos: false, hideDone: false, ...over });

  it("department cuts columns; hide finished drops stages every unit has completed", () => {
    expect(applyBoardFilter(shape, f({ dept: 2 })).stageNos).toEqual([11, 12]);
    expect(applyBoardFilter(shape, f({ hideDone: true })).stageNos).toEqual([11, 12]);
  });

  it("status and out-of-sequence cut rows to the units that have such a cell in view", () => {
    expect(applyBoardFilter(shape, f({ status: "hold" })).unitIds).toEqual([1]);
    expect(applyBoardFilter(shape, f({ oos: true })).unitIds).toEqual([1]);
    expect(applyBoardFilter(shape, f({ status: "hold", dept: 1 })).unitIds).toEqual([]); // the hold is outside the department's columns
    expect(applyBoardFilter(shape, f({})).unitIds).toEqual([1, 2]);
  });
});
