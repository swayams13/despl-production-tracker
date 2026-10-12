import { describe, expect, it } from "vitest";
import {
  isDirty, moveRow, newRow, nextSeq, problemsFromFindings, renumberBy10, rowsFromSteps, toInput, validateRows,
  type EditorRow, type SourceStep,
} from "./_step-model";

const step = (over: Partial<SourceStep> = {}): SourceStep => ({
  seq: 10, operationCode: "RECEIPT", department: "Stores", pvStage: 10, heStage: null, stdTime: 0.5,
  stdTimeUnit: "HOURS", stdTimeBasis: "PER_PIECE", conditional: false, conditionText: "", acceptanceStandard: "",
  recordDocument: "", whatIsDone: "", ...over,
});
const rows = (...s: SourceStep[]): EditorRow[] => rowsFromSteps(s);
const problem = (rs: EditorRow[], field: string) => validateRows(rs).filter((p) => p.field === field);

describe("validateRows — what is refused before the round trip", () => {
  it("accepts a complete row and an incomplete draft row (missing department / stage / time)", () => {
    expect(validateRows(rows(step()))).toEqual([]);
    expect(validateRows(rows(step({ department: "", pvStage: null, stdTime: null, stdTimeUnit: null, stdTimeBasis: null })))).toEqual([]);
  });

  const refused: Array<[string, SourceStep[], string]> = [
    ["no operation", [step({ operationCode: "" })], "operation"],
    ["a duplicate step number", [step(), step({ operationCode: "FIT_UP" })], "seq"],
    ["a zero step number", [step({ seq: 0 })], "seq"],
    ["a time with no unit", [step({ stdTimeUnit: null })], "stdTimeUnit"],
    ["a time with no basis", [step({ stdTimeBasis: null })], "stdTimeBasis"],
    ["a negative time", [step({ stdTime: -1 })], "stdTime"],
    ["a time past the column", [step({ stdTime: 100000 })], "stdTime"],
  ];
  it.each(refused)("refuses %s", (_n, steps, field) => {
    expect(problem(rows(...steps), field).length).toBeGreaterThan(0);
  });

  it("refuses a non-numeric stage typed into a cell", () => {
    const rs = rows(step());
    rs[0].pvStage = "12, 13";
    expect(problem(rs, "pvStage")).toHaveLength(1);
  });
});

describe("toInput", () => {
  it("turns blanks into null, parses numbers, trims text, and sorts by step number", () => {
    const rs = rows(step({ seq: 20, operationCode: "FIT_UP" }), step({ seq: 10, department: "", pvStage: null, stdTime: null, stdTimeUnit: null, stdTimeBasis: null }));
    rs[0].conditionText = "  if thick  ";
    const out = toInput(rs);
    expect(out.map((s) => s.seq)).toEqual([10, 20]);
    expect(out[0]).toMatchObject({ department: "", pvStage: null, stdTime: null, stdTimeUnit: null, stdTimeBasis: null });
    expect(out[1]).toMatchObject({ pvStage: 10, stdTime: 0.5, conditionText: "if thick", requiresQc: true });
  });
});

describe("row operations", () => {
  const three = () => rows(step({ seq: 10 }), step({ seq: 20, operationCode: "FIT_UP" }), step({ seq: 30, operationCode: "WELDING" }));

  it("nextSeq continues in tens, and starts at 10", () => {
    expect(nextSeq([])).toBe(10);
    expect(nextSeq(three())).toBe(40);
    expect(nextSeq(rows(step({ seq: 25 })))).toBe(30);
  });

  it("newRow takes the next number and is blank otherwise", () => {
    const r = newRow(three());
    expect(r).toMatchObject({ seq: "40", operationCode: "", stdTime: "", conditional: false });
  });

  it("moveRow swaps neighbours and stops at the ends", () => {
    const rs = three();
    expect(moveRow(rs, 1, -1).map((r) => r.operationCode)).toEqual(["FIT_UP", "RECEIPT", "WELDING"]);
    expect(moveRow(rs, 0, -1).map((r) => r.operationCode)).toEqual(["RECEIPT", "FIT_UP", "WELDING"]);
    expect(moveRow(rs, 2, 1)).toHaveLength(3);
  });

  it("renumberBy10 follows the current order", () => {
    const rs = moveRow(three(), 2, -1);
    expect(renumberBy10(rs).map((r) => [r.seq, r.operationCode])).toEqual([["10", "RECEIPT"], ["20", "WELDING"], ["30", "FIT_UP"]]);
  });

  it("isDirty ignores row keys and cosmetic whitespace but sees a real change", () => {
    const a = three();
    const b = rowsFromSteps(three().map((r) => step({ seq: Number(r.seq), operationCode: r.operationCode })));
    expect(isDirty(a, b)).toBe(false);
    b[0].acceptanceStandard = "  ";
    expect(isDirty(a, b)).toBe(false);
    b[0].acceptanceStandard = "UW-11";
    expect(isDirty(a, b)).toBe(true);
  });
});

describe("problemsFromFindings", () => {
  it("places each finding on its row and cell by step number; part-level findings are skipped", () => {
    const rs = rows(step({ seq: 10 }), step({ seq: 20 }));
    const out = problemsFromFindings(rs, [
      { variant: "A", seq: 20, code: "MISSING_STAGE", message: "no HE stage", fields: ["heStage"] },
      { variant: "A", seq: 10, code: "DEPARTMENT_STAGE_MISMATCH", message: "dept", fields: ["department", "pvStage"] },
      { variant: null, seq: null, code: "ROUTE_SOURCE", message: "source", fields: [] },
      { variant: "A", seq: 99, code: "MISSING_DEPARTMENT", message: "gone", fields: ["department"] },
    ]);
    expect(out.map((p) => [p.key === rs[0].key ? "r0" : "r1", p.field])).toEqual([["r1", "heStage"], ["r0", "department"], ["r0", "pvStage"]]);
  });
});
