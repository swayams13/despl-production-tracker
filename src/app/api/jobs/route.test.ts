import { describe, expect, it } from "vitest";
import { resolvePageSize } from "./route";

describe("resolvePageSize", () => {
  it("caps an oversized pageSize instead of passing it through raw", () => {
    // Gate 4 review finding: an uncapped pageSize would let a caller force
    // loadJobs's batched-extras pipeline over the whole tenant in one request.
    expect(resolvePageSize("100000")).toBe(200);
  });

  it("defaults to 50 when absent", () => {
    expect(resolvePageSize(null)).toBe(50);
  });

  it("falls back to the default for zero, negative, or garbage values", () => {
    // "0" and negative numbers are falsy/handled by `|| 50` the same as NaN —
    // there's no legitimate zero-or-negative pageSize, so default is correct.
    expect(resolvePageSize("0")).toBe(50);
    expect(resolvePageSize("-5")).toBe(1); // -5 is truthy, then floored to the 1 minimum
    expect(resolvePageSize("not-a-number")).toBe(50);
  });

  it("passes a normal in-range value through unchanged", () => {
    expect(resolvePageSize("25")).toBe(25);
  });
});
