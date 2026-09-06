import { describe, expect, it } from "vitest";
import { outOfRangePage } from "./page";

describe("outOfRangePage", () => {
  it("flags a requested page beyond the last real page for redirect", () => {
    // Gate 4 review finding: an out-of-range ?page= must not silently render
    // the "no jobs" empty state while jobs actually exist.
    expect(outOfRangePage(5, 3)).toBe(3);
  });

  it("leaves an in-range page alone", () => {
    expect(outOfRangePage(2, 3)).toBeNull();
    expect(outOfRangePage(3, 3)).toBeNull();
  });

  it("leaves page 1 alone even with zero jobs (totalPages 0 clamped to 1 by the caller)", () => {
    expect(outOfRangePage(1, 1)).toBeNull();
  });
});
