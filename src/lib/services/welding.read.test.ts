import { describe, expect, it } from "vitest";
import { repairRatePct, isRepairRateFlagged, deltaVsTeamAvgPct } from "./welding.read";

describe("repairRatePct", () => {
  it("is null with no ACCEPT/REJECT results yet", () => {
    expect(repairRatePct(0, 0)).toBeNull();
  });
  it("is the REJECT share of ACCEPT+REJECT, ignoring PENDING entirely", () => {
    expect(repairRatePct(94, 6)).toBe(6);
    expect(repairRatePct(9, 1)).toBe(10);
  });
});

describe("isRepairRateFlagged", () => {
  it("flags strictly above the threshold, not at it (§4.7: 'above 6%')", () => {
    expect(isRepairRateFlagged(6, 6)).toBe(false);
    expect(isRepairRateFlagged(6.1, 6)).toBe(true);
  });
  it("never flags a null (no-data) rate", () => {
    expect(isRepairRateFlagged(null, 6)).toBe(false);
  });
});

describe("deltaVsTeamAvgPct", () => {
  it("is null when the team average is zero (no divide-by-zero)", () => {
    expect(deltaVsTeamAvgPct(5, 0)).toBeNull();
  });
  it("is a signed percentage vs the average", () => {
    expect(deltaVsTeamAvgPct(29, 27.5)).toBe(5);
    expect(deltaVsTeamAvgPct(22, 27.5)).toBe(-20);
  });
});
