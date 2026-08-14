import { describe, expect, it } from "vitest";
import { applyOverride } from "./override";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { pressureVesselEdges, pressureVesselProcesses } from "./__fixtures__/pressure-vessel-v1";

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : "NOT_AN_APP_ERROR";
  }
}

describe("applyOverride — mandatory reason (CLAUDE.md invariant #6)", () => {
  it.each([
    { name: "empty string", reason: "" },
    { name: "whitespace only", reason: "   " },
  ])("refuses with OVERRIDE_REASON_REQUIRED for a $name reason", ({ reason }) => {
    expect(
      codeOf(() =>
        applyOverride(pressureVesselProcesses, pressureVesselEdges, {
          processId: 16,
          durationOverrideDays: 10,
          reason,
        }),
      ),
    ).toBe(ERROR_CODES.OVERRIDE_REASON_REQUIRED);
  });

  it("accepts a real reason", () => {
    expect(
      codeOf(() =>
        applyOverride(pressureVesselProcesses, pressureVesselEdges, {
          processId: 16,
          durationOverrideDays: 10,
          reason: "Welder shortage — SJ approved 3-day extension on Shell Welding",
        }),
      ),
    ).toBeNull();
  });
});

describe("applyOverride — baseline is preserved, never mutated", () => {
  const result = applyOverride(pressureVesselProcesses, pressureVesselEdges, {
    processId: 16, // Shell Welding, duration 3-7 days
    durationOverrideDays: 20, // a large, deliberately schedule-moving override
    reason: "Weld repair rework after failed NDE — SJ approved",
  });

  it("baseline still reflects the un-overridden 36-process plan (P36 finishes at day 119)", () => {
    const p36 = result.baseline.find((n) => n.processId === 36)!;
    expect(p36.earlyFinish).toBe(119);
  });

  it("current reflects the override and pushes the downstream finish out by the extra duration", () => {
    const baselineP36 = result.baseline.find((n) => n.processId === 36)!;
    const currentP36 = result.current.find((n) => n.processId === 36)!;
    // P16's duration went from 7 (max) to 20 — 13 extra days ripple to the terminal process
    // since P16 sits on the (zero-float) critical path.
    expect(currentP36.earlyFinish).toBe(baselineP36.earlyFinish + 13);
  });

  it("baseline and current are distinct arrays — overriding never mutates the input plan", () => {
    expect(result.baseline).not.toBe(result.current);
    const p16Baseline = result.baseline.find((n) => n.processId === 16)!;
    expect(p16Baseline.earlyFinish - p16Baseline.earlyStart).toBe(7); // durationMaxDays, unchanged
  });
});

describe("applyOverride — chaining multiple overrides preserves each prior baseline", () => {
  it("a second override's baseline reflects the first override, not the original plan", () => {
    const first = applyOverride(pressureVesselProcesses, pressureVesselEdges, {
      processId: 16,
      durationOverrideDays: 20,
      reason: "Weld repair rework",
    });
    const priorOverrides = new Map([[16, 20]]);
    const second = applyOverride(
      pressureVesselProcesses,
      pressureVesselEdges,
      { processId: 21, durationOverrideDays: 15, reason: "Extended PWHT cycle" },
      priorOverrides,
    );

    const firstCurrentP36 = first.current.find((n) => n.processId === 36)!;
    const secondBaselineP36 = second.baseline.find((n) => n.processId === 36)!;
    expect(secondBaselineP36.earlyFinish).toBe(firstCurrentP36.earlyFinish);
  });
});
