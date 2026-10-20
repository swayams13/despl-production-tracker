import { describe, expect, it } from "vitest";
import { isValidQuestionKey, questionsForLine, resolveAnswers, validateAnswers, type ConfigQuestionDef } from "./config-questions";

const Q: ConfigQuestionDef[] = [
  { key: "design_pressure", label: "Design pressure", type: "NUMBER", unit: "kg/cm²" },
  { key: "moc", label: "MOC", type: "TEXT" },
  { key: "radiography", label: "Radiography", type: "SELECT", options: ["Full", "Spot", "None"], default: "Spot" },
  { key: "pwht_required", label: "PWHT", type: "BOOLEAN", default: false },
  { key: "skirt_height", label: "Skirt height", type: "NUMBER", equipmentTypeId: 7 },
];

describe("isValidQuestionKey", () => {
  it.each(["", "Design", "1abc", "a b", "a-b", "designPressure", "a.b"])("rejects %j", (k) => expect(isValidQuestionKey(k)).toBe(false));
  it.each(["a", "design_pressure", "n2"])("accepts %j", (k) => expect(isValidQuestionKey(k)).toBe(true));
});

describe("validateAnswers", () => {
  it("drops unknown keys and uncoercible values instead of storing them", () => {
    expect(
      validateAnswers(Q, { design_pressure: "abc", moc: "  SA 516  ", radiography: "Half", extra: "x", pwht_required: "maybe" }),
    ).toEqual({ moc: "SA 516" });
  });
  it("coerces numbers, booleans and select values", () => {
    expect(validateAnswers(Q, { design_pressure: " 12.5 ", pwht_required: "Yes", radiography: "Full" })).toEqual({
      design_pressure: 12.5,
      pwht_required: true,
      radiography: "Full",
    });
    expect(validateAnswers(Q, { pwht_required: false })).toEqual({ pwht_required: false });
  });
  it("treats blank and null as unanswered", () => {
    expect(validateAnswers(Q, { design_pressure: "", moc: "  ", radiography: null })).toEqual({});
    expect(validateAnswers(Q, null)).toEqual({});
  });
  it("rejects non-finite numbers", () => {
    expect(validateAnswers(Q, { design_pressure: "Infinity" })).toEqual({});
  });
});

describe("questionsForLine", () => {
  it("gives family-level questions to everyone and type questions only to their type", () => {
    expect(questionsForLine(Q, null).map((q) => q.key)).not.toContain("skirt_height");
    expect(questionsForLine(Q, 8).map((q) => q.key)).not.toContain("skirt_height");
    expect(questionsForLine(Q, 7).map((q) => q.key)).toContain("skirt_height");
    expect(questionsForLine(Q, 7)).toHaveLength(5);
  });
});

describe("resolveAnswers", () => {
  it("fills defaults only for unanswered keys and names them", () => {
    const { resolved, defaulted } = resolveAnswers(Q, { radiography: "Full" });
    expect(resolved).toEqual({ radiography: "Full", pwht_required: false });
    expect(defaulted).toEqual(["pwht_required"]);
  });
  it("keeps an explicit false instead of replacing it with the default", () => {
    const withTrueDefault: ConfigQuestionDef[] = [{ key: "x", label: "x", type: "BOOLEAN", default: true }];
    expect(resolveAnswers(withTrueDefault, { x: false }).resolved).toEqual({ x: false });
  });
});
