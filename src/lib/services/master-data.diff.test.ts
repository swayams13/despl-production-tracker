import { describe, expect, it } from "vitest";
import type { NormalStep } from "./master-import.rules";
import { diffSteps } from "./master-data.diff";

const step = (over: Partial<NormalStep> = {}): NormalStep => ({
  row: 0, seq: 10, operationCode: "RECEIPT", whatIsDone: "", department: "Stores", pvStage: 10, heStage: null,
  stdTime: 0.5, stdTimeUnit: "HOURS", stdTimeBasis: "PER_PIECE", conditional: false, conditionText: "",
  acceptanceStandard: "", recordDocument: "", requiresQc: true, ...over,
});

describe("diffSteps — what a revision changes against the live version", () => {
  it("is empty when nothing changed (row numbers do not count)", () => {
    expect(diffSteps([step()], [step({ row: 9 })])).toEqual([]);
  });

  const cases: Array<[string, NormalStep[], NormalStep[], unknown]> = [
    ["a step added", [step()], [step(), step({ seq: 20 })], [{ seq: 20, kind: "added" }]],
    ["a step removed", [step(), step({ seq: 20 })], [step()], [{ seq: 20, kind: "removed" }]],
    ["a time changed", [step()], [step({ stdTime: 0.9 })], [{ seq: 10, kind: "changed", fields: ["time"] }]],
    ["department and stage changed", [step()], [step({ department: "QC", pvStage: 11 })], [{ seq: 10, kind: "changed", fields: ["department", "PV stage"] }]],
    ["an acceptance standard added", [step()], [step({ acceptanceStandard: "UW-11" })], [{ seq: 10, kind: "changed", fields: ["acceptance"] }]],
  ];
  it.each(cases)("%s", (_n, before, after, expected) => {
    expect(diffSteps(before, after)).toEqual(expected);
  });

  it("is ordered by step number across added, removed and changed", () => {
    const d = diffSteps([step({ seq: 30 }), step({ seq: 10 })], [step({ seq: 20 }), step({ seq: 10, stdTime: 2 })]);
    expect(d.map((c) => [c.seq, c.kind])).toEqual([[10, "changed"], [20, "added"], [30, "removed"]]);
  });
});
