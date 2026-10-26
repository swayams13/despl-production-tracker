import { describe, expect, it } from "vitest";
import { sCurveVarianceLabel, sCurveVariancePct } from "./_s-curve-variance";

describe("S-curve legend variance", () => {
  it.each<[string, Array<{ planned: number; actual: number | null }>, number | null]>([
    ["nothing completed yet is not -100%", [{ planned: 4, actual: 0 }, { planned: 8, actual: 0 }], null],
    ["no actual weeks at all", [{ planned: 4, actual: null }], null],
    ["no baseline", [{ planned: 0, actual: 3 }], null],
    ["empty series", [], null],
    ["behind plan", [{ planned: 4, actual: 2 }, { planned: 10, actual: 8 }, { planned: 12, actual: null }], -20],
    ["ahead of plan, one decimal", [{ planned: 8, actual: 9 }], 12.5],
    ["on plan", [{ planned: 5, actual: 5 }], 0],
  ])("%s", (_n, curve, expected) => {
    expect(sCurveVariancePct(curve)).toBe(expected);
  });
  it("labels", () => {
    expect(sCurveVarianceLabel(null)).toBe("");
    expect(sCurveVarianceLabel(12.5)).toBe(" · +12.5%");
    expect(sCurveVarianceLabel(-20)).toBe(" · -20%");
    expect(sCurveVarianceLabel(0)).toBe(" · 0%");
  });
});
