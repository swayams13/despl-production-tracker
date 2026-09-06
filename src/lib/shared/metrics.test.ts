import { describe, expect, it } from "vitest";
import { pctOf } from "./metrics";

describe("pctOf", () => {
  it("returns null when total is 0, not 0%", () => {
    expect(pctOf(0, 0)).toBeNull();
  });

  it("rounds to the nearest whole percent", () => {
    expect(pctOf(1, 3)).toBe(33);
    expect(pctOf(2, 3)).toBe(67);
  });

  it("handles the full-count and zero-count cases", () => {
    expect(pctOf(5, 5)).toBe(100);
    expect(pctOf(0, 5)).toBe(0);
  });
});
