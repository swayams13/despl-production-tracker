import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { toYmd, utcDate } from "@/lib/calendar";
import { bypassExcluded, topoOrder } from "./graph";
import { checkFeasibility, envelopePlan } from "./envelope";
import { backwardPass, forwardPass } from "./cpm";
import type { ScheduleEdge, ScheduleProcess } from "./types";

/**
 * Tests for the scheduling engine.
 *
 * Two kinds, deliberately. Synthetic cases pin the RULES with numbers small
 * enough to check by hand. The Pressure Vessel cases replay DESPL's real
 * 36-process table straight out of `seed/lead-time-model.json`, because the
 * engine's whole claim is that it reproduces their printed lead time — a claim
 * that is only worth anything against the real figures.
 */

// ── Fixtures ────────────────────────────────────────────────────────────

interface SeedProcess {
  code: number;
  name: string;
  durationDays: { minDays: number; maxDays: number };
  envelope: {
    finishByMinDays: number;
    finishByMaxDays: number;
    startByMinDays: number;
    startByMaxDays: number;
  };
  edges: { predecessor: number; type: ScheduleEdge["type"]; lagDays: number }[];
}

function loadPressureVessel(): {
  processes: ScheduleProcess[];
  edges: ScheduleEdge[];
  seed: SeedProcess[];
} {
  const file = path.join(process.cwd(), "seed", "lead-time-model.json");
  const seed = JSON.parse(readFileSync(file, "utf8")).processes as SeedProcess[];

  const processes: ScheduleProcess[] = seed.map((p) => ({
    code: String(p.code),
    name: p.name,
    seq: p.code,
    included: true,
    provisional: false,
    durationMinDays: p.durationDays.minDays,
    durationMaxDays: p.durationDays.maxDays,
    durationOverrideDays: null,
    envelopeFinishByMinDays: p.envelope.finishByMinDays,
    envelopeFinishByMaxDays: p.envelope.finishByMaxDays,
  }));

  const edges: ScheduleEdge[] = seed.flatMap((p) =>
    p.edges.map((e) => ({
      processCode: String(p.code),
      predecessorCode: String(e.predecessor),
      type: e.type,
      lagDays: e.lagDays,
    })),
  );

  return { processes, edges, seed };
}

/** A minimal schedulable process; override only what a case is about. */
function proc(over: Partial<ScheduleProcess> & { code: string }): ScheduleProcess {
  return {
    name: `Process ${over.code}`,
    seq: Number(over.code),
    included: true,
    provisional: false,
    durationMinDays: 1,
    durationMaxDays: 2,
    durationOverrideDays: null,
    envelopeFinishByMinDays: 1,
    envelopeFinishByMaxDays: 2,
    ...over,
  };
}

function edge(processCode: string, predecessorCode: string, lagDays = 0): ScheduleEdge {
  return {
    processCode,
    predecessorCode,
    type: lagDays >= 0 ? "FINISH_TO_START" : "START_TO_START_WITH_OVERLAP",
    lagDays,
  };
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : "NOT_AN_APP_ERROR";
  }
}

const PROJECT_START = utcDate(2026, 6, 24);

// ── The golden regression ───────────────────────────────────────────────

describe("CPM reproduces the printed envelope (BUILD-SPEC-v2 §1.3)", () => {
  const { processes, edges, seed } = loadPressureVessel();

  it("loads all 36 Pressure Vessel processes", () => {
    expect(processes).toHaveLength(36);
  });

  it("lands every process on its seeded envelope figure, all 36 of them", () => {
    const plan = forwardPass(processes, edges, PROJECT_START);
    const byCode = new Map(plan.map((p) => [p.code, p]));

    const mismatches = seed.filter(
      (s) => byCode.get(String(s.code))!.finishOffset !== s.envelope.finishByMaxDays,
    );
    expect(mismatches.map((m) => m.code)).toEqual([]);
  });

  it("derives every start offset to the seeded startBy figure", () => {
    const plan = forwardPass(processes, edges, PROJECT_START);
    const byCode = new Map(plan.map((p) => [p.code, p]));

    const mismatches = seed.filter(
      (s) => byCode.get(String(s.code))!.startOffset !== s.envelope.startByMaxDays,
    );
    expect(mismatches.map((m) => m.code)).toEqual([]);
  });

  it("finishes the terminal process on day 119 — DESPL's printed ~17 weeks", () => {
    const plan = forwardPass(processes, edges, PROJECT_START);
    expect(Math.max(...plan.map((p) => p.finishOffset))).toBe(119);
  });

  it("agrees with the envelope layer process for process", () => {
    const cpm = forwardPass(processes, edges, PROJECT_START);
    const env = envelopePlan(processes, PROJECT_START);
    const envByCode = new Map(env.map((p) => [p.code, p]));

    for (const p of cpm) {
      expect(toYmd(envByCode.get(p.code)!.finish)).toBe(toYmd(p.finish));
      expect(toYmd(envByCode.get(p.code)!.start)).toBe(toYmd(p.start));
    }
  });

  it("never sums durations — the sum is far longer than the envelope (invariant #10)", () => {
    const summed = processes.reduce((n, p) => n + p.durationMaxDays!, 0);
    expect(summed).toBeGreaterThan(119);
  });
});

// ── Feasibility ─────────────────────────────────────────────────────────

describe("feasibility — DE0467, the order accepted too short", () => {
  const { processes } = loadPressureVessel();
  const PO = utcDate(2026, 6, 24);

  it("flags INFEASIBLE by 22 working days against the earliest committed date", () => {
    const result = checkFeasibility(processes, PO, utcDate(2026, 10, 15));
    expect(result).toMatchObject({
      feasibility: "INFEASIBLE",
      availableDays: 97,
      requiredMinDays: 119,
      shortfallDays: 22,
    });
  });

  /**
   * The source dispatch field is a WINDOW: "15.10.2026 - 25.10.2026". Read as
   * the late end it is only 14 days short. We check against the earliest,
   * because the point of a tender-stage warning is to fire before the order is
   * signed. This case exists so the choice stays visible and deliberate — it
   * is 8 working days of difference on a single reading decision.
   */
  it("would report only 14 days short if the late end of the window were used", () => {
    const late = checkFeasibility(processes, PO, utcDate(2026, 10, 25));
    expect(late.shortfallDays).toBe(14);
  });

  it("is FEASIBLE when the full standard lead time is available", () => {
    const result = checkFeasibility(processes, PO, utcDate(2026, 11, 12));
    expect(result.availableDays).toBeGreaterThanOrEqual(119);
    expect(result.feasibility).toBe("FEASIBLE");
  });

  it("reports TIGHT is unreachable for Pressure Vessel — min and max both 119", () => {
    const result = checkFeasibility(processes, PO, utcDate(2026, 10, 15));
    expect(result.requiredMinDays).toBe(result.requiredMaxDays);
  });

  it("still reaches TIGHT for a family that does have a min/max spread", () => {
    const spread = [
      proc({ code: "1", envelopeFinishByMinDays: 5, envelopeFinishByMaxDays: 10 }),
    ];
    // 6 working days available: past the optimistic 5, short of the standard 10.
    const result = checkFeasibility(spread, PROJECT_START, utcDate(2026, 7, 1));
    expect(result.availableDays).toBe(6);
    expect(result.feasibility).toBe("TIGHT");
  });
});

// ── Refusals ────────────────────────────────────────────────────────────

describe("refusals — never guess a date (schema contract on TemplateProcess)", () => {
  it("refuses a provisional process, as PIPE_SPOOL's 16 rows all are", () => {
    const pipeSpool = [
      proc({
        code: "1",
        provisional: true,
        durationMinDays: null,
        durationMaxDays: null,
        envelopeFinishByMinDays: null,
        envelopeFinishByMaxDays: null,
      }),
    ];
    expect(codeOf(() => forwardPass(pipeSpool, [], PROJECT_START))).toBe(
      ERROR_CODES.SCHEDULE_DATA_MISSING,
    );
  });

  it("refuses a null duration even when the process is not flagged provisional", () => {
    const noDuration = [proc({ code: "1", durationMaxDays: null })];
    expect(codeOf(() => forwardPass(noDuration, [], PROJECT_START))).toBe(
      ERROR_CODES.SCHEDULE_DATA_MISSING,
    );
  });

  it("refuses a provisional process even when an override duration is supplied", () => {
    const overridden = [proc({ code: "1", provisional: true, durationOverrideDays: 5 })];
    expect(codeOf(() => forwardPass(overridden, [], PROJECT_START))).toBe(
      ERROR_CODES.SCHEDULE_DATA_MISSING,
    );
  });

  it("names every unplannable process at once, not just the first", () => {
    const many = [
      proc({ code: "1" }),
      proc({ code: "2", provisional: true }),
      proc({ code: "3", durationMaxDays: null }),
    ];
    try {
      forwardPass(many, [], PROJECT_START);
      expect.unreachable("should have refused");
    } catch (e) {
      const detail = (e as AppError).detail as { processes: { code: string }[] };
      expect(detail.processes.map((p) => p.code).sort()).toEqual(["2", "3"]);
    }
  });

  it("ignores an excluded process that has no duration — it is never scheduled", () => {
    const withSkipped = [
      proc({ code: "1" }),
      proc({ code: "2", included: false, provisional: true, durationMaxDays: null }),
    ];
    expect(() => forwardPass(withSkipped, [], PROJECT_START)).not.toThrow();
  });

  it("refuses a cycle rather than looping", () => {
    const cyclic = [proc({ code: "1" }), proc({ code: "2" })];
    const loop = [edge("2", "1"), edge("1", "2")];
    expect(codeOf(() => topoOrder(cyclic, loop))).toBe(ERROR_CODES.SCHEDULE_CYCLE);
  });

  it("refuses an edge pointing at a process that is not in the set", () => {
    expect(codeOf(() => topoOrder([proc({ code: "1" })], [edge("1", "99")]))).toBe(
      ERROR_CODES.SCHEDULE_DATA_MISSING,
    );
  });
});

// ── Excluded processes ──────────────────────────────────────────────────

describe("excluded processes are spliced out, never just dropped", () => {
  it("composes lags across a bypassed process", () => {
    // 1 →(2)→ 2 →(3)→ 3, with 2 excluded, must leave 1 →(5)→ 3.
    const processes = [proc({ code: "1" }), proc({ code: "2", included: false }), proc({ code: "3" })];
    const edges = [edge("2", "1", 2), edge("3", "2", 3)];

    const result = bypassExcluded(processes, edges);
    expect(result.processes.map((p) => p.code)).toEqual(["1", "3"]);
    expect(result.edges).toEqual([
      { processCode: "3", predecessorCode: "1", type: "FINISH_TO_START", lagDays: 5 },
    ]);
  });

  it("handles a run of adjacent excluded processes", () => {
    const processes = [
      proc({ code: "1" }),
      proc({ code: "2", included: false }),
      proc({ code: "3", included: false }),
      proc({ code: "4" }),
    ];
    const edges = [edge("2", "1", 1), edge("3", "2", 1), edge("4", "3", 1)];

    const result = bypassExcluded(processes, edges);
    expect(result.edges).toEqual([
      { processCode: "4", predecessorCode: "1", type: "FINISH_TO_START", lagDays: 3 },
    ]);
  });

  it("keeps the most constraining lag when two routes converge", () => {
    const processes = [
      proc({ code: "1" }),
      proc({ code: "2", included: false }),
      proc({ code: "3" }),
    ];
    // Two routes 1→3 via the excluded 2: lags 1+1=2 and 4+4=8. The 8 must win.
    const edges = [
      edge("2", "1", 1),
      edge("3", "2", 1),
      { ...edge("2", "1", 4), predecessorCode: "1" },
      { ...edge("3", "2", 4) },
    ];
    const result = bypassExcluded(processes, edges);
    expect(Math.max(...result.edges.map((e) => e.lagDays))).toBe(8);
  });

  /**
   * The real hazard. PWHT (P21) sits mid-chain at P20 → P21 → P22 and the
   * DESPL-320 drawing says it is not required for that vessel. Dropped naively,
   * P22 loses its only predecessor, becomes a root, and schedules on day zero —
   * claiming heat treatment's successor can begin before the shell is welded.
   */
  it("does not turn PWHT's successor into a day-zero root when PWHT is skipped", () => {
    const { processes, edges } = loadPressureVessel();
    const withoutPwht = processes.map((p) => (p.code === "21" ? { ...p, included: false } : p));

    const plan = forwardPass(withoutPwht, edges, PROJECT_START);

    expect(plan).toHaveLength(35);
    expect(plan.find((p) => p.code === "22")!.startOffset).toBeGreaterThan(0);

    // Exactly one genuine root — the day-zero slot is not handed out to anyone else.
    expect(plan.filter((p) => p.startOffset === 0).map((p) => p.code)).toEqual(["1"]);
  });

  /**
   * P20 (Nozzle Welding), P21 (PWHT) and P22 (NDE after PWHT) are FULLY
   * CONCURRENT in DESPL's table — all three print start 86, finish 91 — which
   * the seed encodes as two -5 overlap lags. So the correct composed lag when
   * PWHT is skipped is -10, and P22 legitimately starts before P20 finishes.
   * Asserting finish-to-start here would be asserting the wrong model; what
   * must hold is that the DEPENDENCY survives the splice.
   */
  it("removes exactly PWHT's duration from its successor's start, no more", () => {
    const { processes, edges } = loadPressureVessel();
    const withoutPwht = processes.map((p) => (p.code === "21" ? { ...p, included: false } : p));
    const pwhtDuration = processes.find((p) => p.code === "21")!.durationMaxDays!;

    const before = forwardPass(processes, edges, PROJECT_START).find((p) => p.code === "22")!;
    const after = forwardPass(withoutPwht, edges, PROJECT_START).find((p) => p.code === "22")!;

    expect(before.startOffset - after.startOffset).toBe(pwhtDuration);
  });

  it("keeps the successor genuinely dependent on the predecessor after the splice", () => {
    const { processes, edges } = loadPressureVessel();
    const skip21 = (list: ScheduleProcess[]) =>
      list.map((p) => (p.code === "21" ? { ...p, included: false } : p));

    const base = forwardPass(skip21(processes), edges, PROJECT_START);
    // Push P20 out by 3 days; P22 must move with it, or the edge was lost.
    const delayed = forwardPass(
      skip21(processes.map((p) => (p.code === "20" ? { ...p, durationOverrideDays: p.durationMaxDays! + 3 } : p))),
      edges,
      PROJECT_START,
    );

    const shift = (code: string) =>
      delayed.find((p) => p.code === code)!.startOffset - base.find((p) => p.code === code)!.startOffset;
    expect(shift("22")).toBe(3);
  });

  it("shortens the overall schedule when a process is skipped", () => {
    const { processes, edges } = loadPressureVessel();
    const withoutPwht = processes.map((p) => (p.code === "21" ? { ...p, included: false } : p));

    const full = Math.max(...forwardPass(processes, edges, PROJECT_START).map((p) => p.finishOffset));
    const skipped = Math.max(
      ...forwardPass(withoutPwht, edges, PROJECT_START).map((p) => p.finishOffset),
    );
    expect(skipped).toBeLessThan(full);
  });
});

// ── Backward pass and override ──────────────────────────────────────────

describe("backward pass — the finish-by dates that drive notifications", () => {
  const { processes, edges } = loadPressureVessel();

  it("round-trips: backward from the forward finish returns the project start", () => {
    const forward = forwardPass(processes, edges, PROJECT_START);
    const delivery = forward.reduce((a, b) => (a.finish > b.finish ? a : b)).finish;

    const backward = backwardPass(processes, edges, delivery);
    expect(toYmd(backward.find((p) => p.code === "1")!.start)).toBe(toYmd(PROJECT_START));
  });

  it("gives every process float of zero or more, never negative", () => {
    const forward = forwardPass(processes, edges, PROJECT_START);
    const delivery = forward.reduce((a, b) => (a.finish > b.finish ? a : b)).finish;
    const backward = new Map(backwardPass(processes, edges, delivery).map((p) => [p.code, p]));

    for (const p of forward) {
      expect(backward.get(p.code)!.startOffset + 119).toBeGreaterThanOrEqual(p.startOffset);
    }
  });

  it("pulls every finish-by date earlier when the delivery date is pulled in", () => {
    const late = backwardPass(processes, edges, utcDate(2026, 12, 1));
    const early = backwardPass(processes, edges, utcDate(2026, 11, 1));
    for (const p of early) {
      expect(p.finish < late.find((q) => q.code === p.code)!.finish).toBe(true);
    }
  });
});

describe("override — a pinned date cascades, the rest is recomputed", () => {
  it("moves the pinned process and pushes its dependents out", () => {
    const processes = [proc({ code: "1" }), proc({ code: "2" }), proc({ code: "3" })];
    const edges = [edge("2", "1"), edge("3", "2")];

    const base = forwardPass(processes, edges, PROJECT_START);
    const pinned = forwardPass(processes, edges, PROJECT_START, undefined, [
      { processCode: "2", start: utcDate(2026, 7, 6) },
    ]);

    const baseP2 = base.find((p) => p.code === "2")!;
    const pinP2 = pinned.find((p) => p.code === "2")!;
    expect(toYmd(pinP2.start)).toBe("2026-07-06");
    expect(pinP2.startOffset).toBeGreaterThan(baseP2.startOffset);

    // The dependent moved with it; the predecessor did not.
    expect(pinned.find((p) => p.code === "3")!.startOffset).toBeGreaterThan(
      base.find((p) => p.code === "3")!.startOffset,
    );
    expect(pinned.find((p) => p.code === "1")!.startOffset).toBe(
      base.find((p) => p.code === "1")!.startOffset,
    );
  });

  it("leaves an unpinned schedule identical to the plain forward pass", () => {
    const { processes, edges } = loadPressureVessel();
    const plain = forwardPass(processes, edges, PROJECT_START);
    const withNoPins = forwardPass(processes, edges, PROJECT_START, undefined, []);
    expect(withNoPins).toEqual(plain);
  });
});

// ── Negative lags ───────────────────────────────────────────────────────

describe("negative lags are concurrency, not data errors (invariant #11)", () => {
  it("lets a successor start before its predecessor finishes", () => {
    const processes = [proc({ code: "1", durationMaxDays: 10 }), proc({ code: "2" })];
    const plan = forwardPass(processes, [edge("2", "1", -4)], PROJECT_START);

    const p1 = plan.find((p) => p.code === "1")!;
    const p2 = plan.find((p) => p.code === "2")!;
    expect(p2.startOffset).toBe(p1.finishOffset - 4);
    expect(p2.startOffset).toBeLessThan(p1.finishOffset);
  });

  it("uses the real 23 negative edges in the Pressure Vessel table", () => {
    const { edges } = loadPressureVessel();
    const negative = edges.filter((e) => e.lagDays < 0);
    expect(negative).toHaveLength(23);
    expect(negative.every((e) => e.type === "START_TO_START_WITH_OVERLAP")).toBe(true);
  });
});
