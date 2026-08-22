import { describe, expect, it } from "vitest";
import { analyzeGraph } from "./validate";
import type { ScheduleProcess, ScheduleEdge } from "./types";

/** Minimal schedulable process — validate.ts only reads `id`. */
function p(id: number): ScheduleProcess {
  return {
    id,
    code: id,
    name: `P${id}`,
    durationMinDays: 1,
    durationMaxDays: 1,
    envelopeFinishByMinDays: 1,
    envelopeFinishByMaxDays: 1,
    envelopeStartByMinDays: 0,
    envelopeStartByMaxDays: 0,
    provisional: false,
  };
}

function e(predecessorId: number, processId: number): ScheduleEdge {
  return { predecessorId, processId, type: "FINISH_TO_START", lagDays: 0 };
}

describe("analyzeGraph", () => {
  it("reports a clean linear chain as valid", () => {
    const d = analyzeGraph([p(1), p(2), p(3)], [e(1, 2), e(2, 3)]);
    expect(d.danglingEdges).toEqual([]);
    expect(d.selfEdges).toEqual([]);
    expect(d.cycleNodeIds).toEqual([]);
    expect(d.unreachableIds).toEqual([]);
    expect(d.rootIds).toEqual([1]);
    expect(d.terminalIds).toEqual([3]);
  });

  it("reports multiple terminals without treating them as an error", () => {
    // 1 → 2, 1 → 3: two dead ends, exactly the shape of the real PV route.
    const d = analyzeGraph([p(1), p(2), p(3)], [e(1, 2), e(1, 3)]);
    expect(d.terminalIds).toEqual([2, 3]);
    expect(d.cycleNodeIds).toEqual([]);
    expect(d.unreachableIds).toEqual([]);
  });

  it("names both members of a two-node cycle", () => {
    const d = analyzeGraph([p(1), p(2)], [e(1, 2), e(2, 1)]);
    expect(d.cycleNodeIds.sort()).toEqual([1, 2]);
    expect(d.rootIds).toEqual([]);
  });

  it("names every member of a longer cycle, and nothing outside it", () => {
    // 1 → 2 → 3 → 4 → 2 : the 2-3-4 loop, with 1 a clean root.
    const d = analyzeGraph([p(1), p(2), p(3), p(4)], [e(1, 2), e(2, 3), e(3, 4), e(4, 2)]);
    expect(d.cycleNodeIds.sort()).toEqual([2, 3, 4]);
    expect(d.rootIds).toEqual([1]);
  });

  it("reports an orphan unreachable from any root", () => {
    // 3 exists but nothing points at it and it points at nothing.
    const d = analyzeGraph([p(1), p(2), p(3)], [e(1, 2)]);
    expect(d.unreachableIds).toEqual([]); // 3 is itself a root
    expect(d.rootIds.sort()).toEqual([1, 3]);
  });

  it("reports a node reachable only from inside a cycle as unreachable", () => {
    // 1 is a lone root going nowhere; 2 ↔ 3 loop feeds 4.
    const d = analyzeGraph([p(1), p(2), p(3), p(4)], [e(2, 3), e(3, 2), e(3, 4)]);
    expect(d.rootIds).toEqual([1]);
    expect(d.unreachableIds.sort()).toEqual([2, 3, 4]);
    expect(d.cycleNodeIds.sort()).toEqual([2, 3, 4]);
  });

  it("collects dangling edges instead of throwing", () => {
    const bad = e(1, 99);
    const d = analyzeGraph([p(1), p(2)], [e(1, 2), bad]);
    expect(d.danglingEdges).toEqual([bad]);
    expect(d.cycleNodeIds).toEqual([]);
  });

  it("collects a self-edge and excludes it from the graph", () => {
    const self = e(2, 2);
    const d = analyzeGraph([p(1), p(2)], [e(1, 2), self]);
    expect(d.selfEdges).toEqual([self]);
    // With the self-edge excluded, 2 is still properly reachable from 1.
    expect(d.cycleNodeIds).toEqual([]);
    expect(d.unreachableIds).toEqual([]);
  });

  it("handles an empty graph", () => {
    const d = analyzeGraph([], []);
    expect(d).toEqual({
      danglingEdges: [],
      selfEdges: [],
      cycleNodeIds: [],
      rootIds: [],
      terminalIds: [],
      unreachableIds: [],
    });
  });
});
