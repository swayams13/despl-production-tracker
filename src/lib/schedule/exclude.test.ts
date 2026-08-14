import { describe, expect, it } from "vitest";
import { bypassExcluded } from "./exclude";
import { computeCpm } from "./cpm";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  pressureVesselEdges,
  pressureVesselProcesses,
  PRESSURE_VESSEL_TOTAL_DAYS,
} from "./__fixtures__/pressure-vessel-v1";
import type { ScheduleEdge, ScheduleProcess } from "./types";

/** A minimal hand-built process — only the fields bypassExcluded/computeCpm read. */
function proc(id: number, durationMaxDays: number | null): ScheduleProcess {
  return {
    id,
    code: id,
    name: `P${id}`,
    durationMinDays: durationMaxDays,
    durationMaxDays,
    envelopeFinishByMinDays: null,
    envelopeFinishByMaxDays: null,
    envelopeStartByMinDays: null,
    envelopeStartByMaxDays: null,
    provisional: false,
  };
}

describe("bypassExcluded — PWHT (P21) excluded on the real fixture", () => {
  const processes = pressureVesselProcesses.map((p) =>
    p.code === 21 ? { ...p, included: false } : p,
  );

  it("splices P21 out and composes a direct P20 -> P22 edge with lag -5 (lagPX + duration(X) + lagXS = -5 + 5 + -5)", () => {
    const spliced = bypassExcluded(processes, pressureVesselEdges);
    expect(spliced.processes.find((p) => p.code === 21)).toBeUndefined();
    const bridge = spliced.edges.find((e) => e.predecessorId === 20 && e.processId === 22);
    expect(bridge).toBeDefined();
    expect(bridge!.lagDays).toBe(-5);
  });

  it("computeCpm on the spliced graph does not throw, P22 is not orphaned (earlyStart !== 0), and P36 is unchanged at 119", () => {
    const cpm = computeCpm(processes, pressureVesselEdges);
    const byId = new Map(cpm.map((n) => [n.processId, n]));
    expect(byId.get(21)).toBeUndefined();
    expect(byId.get(22)).toBeDefined();
    expect(byId.get(22)!.earlyStart).not.toBe(0);
    expect(byId.get(36)!.earlyFinish).toBe(PRESSURE_VESSEL_TOTAL_DAYS);
  });
});

describe("bypassExcluded — hand-built composition arithmetic", () => {
  it("serial exclusion (FTS, lag 0): composed A->C lag = 0 + 5 + 0 = 5 — B's gap is preserved", () => {
    const processes = [proc(1, 5), { ...proc(2, 5), included: false }, proc(3, 5)];
    const edges: ScheduleEdge[] = [
      { processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 },
      { processId: 3, predecessorId: 2, type: "FINISH_TO_START", lagDays: 0 },
    ];

    const spliced = bypassExcluded(processes, edges);
    expect(spliced.edges).toEqual([
      { processId: 3, predecessorId: 1, type: "FINISH_TO_START", lagDays: 5 },
    ]);

    const cpm = computeCpm(processes, edges);
    const byId = new Map(cpm.map((n) => [n.processId, n]));
    expect(byId.get(3)!.earlyStart).toBe(byId.get(1)!.earlyFinish + 5); // 5 + 5 = 10
  });

  it("serial exclusion but concurrent (SS, lag -5): composed lag = -5 + 5 + -5 = -5 — C lands unchanged relative to A", () => {
    const processes = [proc(1, 5), { ...proc(2, 5), included: false }, proc(3, 5)];
    const edges: ScheduleEdge[] = [
      { processId: 2, predecessorId: 1, type: "START_TO_START_WITH_OVERLAP", lagDays: -5 },
      { processId: 3, predecessorId: 2, type: "START_TO_START_WITH_OVERLAP", lagDays: -5 },
    ];

    const spliced = bypassExcluded(processes, edges);
    expect(spliced.edges).toEqual([
      { processId: 3, predecessorId: 1, type: "START_TO_START_WITH_OVERLAP", lagDays: -5 },
    ]);

    const cpm = computeCpm(processes, edges);
    const byId = new Map(cpm.map((n) => [n.processId, n]));
    expect(byId.get(3)!.earlyStart).toBe(byId.get(1)!.earlyStart); // both 0
  });

  it("multiple paths through different excluded nodes to the same successor: dedup keeps the max-lag composed edge", () => {
    // A -> X -> S (X excluded, duration 3) and A -> Y -> S (Y excluded, duration 7),
    // both FTS/lag 0 legs. Composed A->S lag via X = 0+3+0 = 3, via Y = 0+7+0 = 7.
    // Dedup must keep the max (7) — the most-constraining path governs.
    const processes = [
      proc(1, 0),
      { ...proc(2, 3), included: false },
      { ...proc(3, 7), included: false },
      proc(4, 0),
    ];
    const edges: ScheduleEdge[] = [
      { processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 }, // A -> X
      { processId: 4, predecessorId: 2, type: "FINISH_TO_START", lagDays: 0 }, // X -> S
      { processId: 3, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 }, // A -> Y
      { processId: 4, predecessorId: 3, type: "FINISH_TO_START", lagDays: 0 }, // Y -> S
    ];

    const spliced = bypassExcluded(processes, edges);
    expect(spliced.edges).toEqual([
      { processId: 4, predecessorId: 1, type: "FINISH_TO_START", lagDays: 7 },
    ]);
  });

  it("chain of two adjacent excluded nodes composes to a single edge, no leftover references", () => {
    // A ->(lag2) B ->(lag1) C ->(lag3) D, B and C excluded (durations 4, 6).
    // Composed A->D lag = 2 + 4 + 1 + 6 + 3 = 16.
    const processes = [
      proc(1, 10),
      { ...proc(2, 4), included: false },
      { ...proc(3, 6), included: false },
      proc(4, 10),
    ];
    const edges: ScheduleEdge[] = [
      { processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 2 },
      { processId: 3, predecessorId: 2, type: "FINISH_TO_START", lagDays: 1 },
      { processId: 4, predecessorId: 3, type: "FINISH_TO_START", lagDays: 3 },
    ];

    const spliced = bypassExcluded(processes, edges);
    expect(spliced.processes.map((p) => p.id)).toEqual([1, 4]);
    expect(spliced.edges).toEqual([
      { processId: 4, predecessorId: 1, type: "FINISH_TO_START", lagDays: 16 },
    ]);
    expect(
      spliced.edges.some(
        (e) => [e.processId, e.predecessorId].some((id) => id === 2 || id === 3),
      ),
    ).toBe(false);
  });

  it("refuses with SCHEDULE_DATA_MISSING when an excluded node has no usable duration", () => {
    const processes: ScheduleProcess[] = [
      proc(1, 5),
      { ...proc(2, 5), durationMaxDays: null, included: false },
      proc(3, 5),
    ];
    const edges: ScheduleEdge[] = [
      { processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 },
      { processId: 3, predecessorId: 2, type: "FINISH_TO_START", lagDays: 0 },
    ];

    expect(() => bypassExcluded(processes, edges)).toThrow(AppError);
    try {
      bypassExcluded(processes, edges);
      throw new Error("expected bypassExcluded to throw");
    } catch (e) {
      expect((e as AppError).code).toBe(ERROR_CODES.SCHEDULE_DATA_MISSING);
    }
  });

  it("no-op when nothing is excluded: same processes/edges membership, computeCpm output identical", () => {
    const processes = [proc(1, 5), proc(2, 5)];
    const edges: ScheduleEdge[] = [
      { processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 },
    ];

    const spliced = bypassExcluded(processes, edges);
    expect(spliced.processes).toBe(processes);
    expect(spliced.edges).toBe(edges);

    const direct = computeCpm(processes, edges);
    const viaBypass = computeCpm(
      bypassExcluded(processes, edges).processes,
      bypassExcluded(processes, edges).edges,
    );
    expect(viaBypass).toEqual(direct);
  });
});
