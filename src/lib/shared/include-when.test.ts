import { describe, expect, it } from "vitest";
import { evaluateIncludeWhen } from "./include-when";

type Row = [string, unknown, Record<string, unknown>, { included: boolean; flagged: boolean }];

describe("evaluateIncludeWhen: unreadable rules include and flag, never exclude", () => {
  it.each<[string, unknown]>([
    ["unknown op", { all: [{ key: "a", op: "gt", value: 1 }] }],
    ["both all and any", { all: [{ key: "a", op: "truthy" }], any: [{ key: "b", op: "truthy" }] }],
    ["empty list", { all: [] }],
    ["extra property", { all: [{ key: "a", op: "truthy" }], note: "x" }],
    ["upper-case key", { all: [{ key: "Pwht", op: "truthy" }] }],
    ["eq without value", { all: [{ key: "a", op: "eq" }] }],
    ["eq with an array", { all: [{ key: "a", op: "eq", value: ["x"] }] }],
    ["in with a scalar", { all: [{ key: "a", op: "in", value: "x" }] }],
    ["in with an empty array", { all: [{ key: "a", op: "in", value: [] }] }],
    ["truthy with a value", { all: [{ key: "a", op: "truthy", value: true }] }],
    ["a string, not an object", "pwht"],
    ["code-looking text", { all: [{ key: "a", op: "eq", value: { $gt: 1 } }] }],
  ])("%s", (_label, rule) => {
    const d = evaluateIncludeWhen(rule, { a: 1, b: true });
    expect(d).toMatchObject({ included: true, flagged: true });
    expect(d.reason.invalid).toBeTruthy();
  });
});

describe("evaluateIncludeWhen: decisions", () => {
  it("no rule: included, not flagged", () => {
    expect(evaluateIncludeWhen(null, {})).toMatchObject({ included: true, flagged: false });
    expect(evaluateIncludeWhen(undefined, {})).toMatchObject({ included: true, flagged: false });
  });

  const rows: Row[] = [
    // eq
    ["eq match", { all: [{ key: "orientation", op: "eq", value: "Vertical" }] }, { orientation: "Vertical" }, { included: true, flagged: false }],
    ["eq no match", { all: [{ key: "orientation", op: "eq", value: "Vertical" }] }, { orientation: "Horizontal" }, { included: false, flagged: false }],
    ["eq is case-sensitive for text", { all: [{ key: "orientation", op: "eq", value: "Vertical" }] }, { orientation: "vertical" }, { included: false, flagged: false }],
    ["eq boolean answer against text rule value", { all: [{ key: "pwht", op: "eq", value: "true" }] }, { pwht: true }, { included: true, flagged: false }],
    ["eq number answer against text rule value", { all: [{ key: "n", op: "eq", value: "12" }] }, { n: 12 }, { included: true, flagged: false }],
    // neq
    ["neq match", { all: [{ key: "radiography", op: "neq", value: "None" }] }, { radiography: "Full" }, { included: true, flagged: false }],
    ["neq no match", { all: [{ key: "radiography", op: "neq", value: "None" }] }, { radiography: "None" }, { included: false, flagged: false }],
    // in
    ["in match", { all: [{ key: "radiography", op: "in", value: ["Full", "Spot"] }] }, { radiography: "Spot" }, { included: true, flagged: false }],
    ["in no match", { all: [{ key: "radiography", op: "in", value: ["Full", "Spot"] }] }, { radiography: "None" }, { included: false, flagged: false }],
    // truthy
    ["truthy true", { all: [{ key: "pwht", op: "truthy" }] }, { pwht: true }, { included: true, flagged: false }],
    ["truthy false", { all: [{ key: "pwht", op: "truthy" }] }, { pwht: false }, { included: false, flagged: false }],
    ["truthy zero", { all: [{ key: "n", op: "truthy" }] }, { n: 0 }, { included: false, flagged: false }],
    ["truthy non-zero", { all: [{ key: "n", op: "truthy" }] }, { n: 3 }, { included: true, flagged: false }],
    ["truthy the word No", { all: [{ key: "s", op: "truthy" }] }, { s: " No " }, { included: false, flagged: false }],
    ["truthy a real word", { all: [{ key: "s", op: "truthy" }] }, { s: "Full" }, { included: true, flagged: false }],
    // all / any
    ["all: one false excludes", { all: [{ key: "a", op: "truthy" }, { key: "b", op: "truthy" }] }, { a: true, b: false }, { included: false, flagged: false }],
    ["all: every true includes", { all: [{ key: "a", op: "truthy" }, { key: "b", op: "truthy" }] }, { a: true, b: true }, { included: true, flagged: false }],
    ["any: one true includes", { any: [{ key: "a", op: "truthy" }, { key: "b", op: "truthy" }] }, { a: false, b: true }, { included: true, flagged: false }],
    ["any: all false excludes", { any: [{ key: "a", op: "truthy" }, { key: "b", op: "truthy" }] }, { a: false, b: false }, { included: false, flagged: false }],
    // missing answers: default is include, flagged
    ["all: single missing includes and flags", { all: [{ key: "pwht", op: "truthy" }] }, {}, { included: true, flagged: true }],
    ["all: missing but another clause false excludes (not flagged)", { all: [{ key: "a", op: "truthy" }, { key: "b", op: "truthy" }] }, { b: false }, { included: false, flagged: false }],
    ["all: missing and the rest true includes and flags", { all: [{ key: "a", op: "truthy" }, { key: "b", op: "truthy" }] }, { b: true }, { included: true, flagged: true }],
    ["any: missing and the rest false includes and flags", { any: [{ key: "a", op: "truthy" }, { key: "b", op: "truthy" }] }, { b: false }, { included: true, flagged: true }],
    ["any: missing but another clause true includes (not flagged)", { any: [{ key: "a", op: "truthy" }, { key: "b", op: "truthy" }] }, { b: true }, { included: true, flagged: false }],
    ["an object answer counts as missing", { all: [{ key: "a", op: "truthy" }] }, { a: { x: 1 } }, { included: true, flagged: true }],
  ];
  it.each(rows)("%s", (_label, rule, answers, want) => {
    expect(evaluateIncludeWhen(rule, answers)).toMatchObject(want);
  });

  it("records the answer used and the missing keys, so the reason can be shown", () => {
    const d = evaluateIncludeWhen({ all: [{ key: "a", op: "eq", value: "x" }, { key: "b", op: "truthy" }] }, { a: "y" });
    expect(d.reason.missing).toEqual(["b"]);
    expect(d.reason.clauses[0]).toMatchObject({ key: "a", answer: "y", result: false });
    expect(d.reason.clauses[1]).toMatchObject({ key: "b", result: null });
  });
});
