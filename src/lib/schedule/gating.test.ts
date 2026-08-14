import { describe, expect, it } from "vitest";
import { assertCanComplete, assertCanStart, type PredecessorState } from "./gating";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { ScheduleEdge } from "./types";

/**
 * Table-driven violation-case tests (CLAUDE.md: "any change to the state
 * machine, gating, RBAC, or audit paths requires table-driven tests for the
 * violation cases, not just happy paths").
 *
 * The central case this file exists to prove (IMPLEMENTATION-GUIDE Step 7):
 * a negative lag never allows a process to be marked COMPLETE before its
 * predecessor, even though it can be marked IN_PROGRESS earlier — gating and
 * scheduling are separate checks.
 */

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : "NOT_AN_APP_ERROR";
  }
}

const finishToStart: ScheduleEdge = {
  processId: 20,
  predecessorId: 19,
  type: "FINISH_TO_START",
  lagDays: 2,
};

const startToStartOverlap: ScheduleEdge = {
  processId: 3,
  predecessorId: 2,
  type: "START_TO_START_WITH_OVERLAP",
  lagDays: -1,
};

// Regression pin: an overlap edge with lagDays === 0 is still concurrent work.
// Gating must key off `type`, not `lagDays >= 0` — the latter would wrongly
// require the predecessor to be COMPLETE before this can start.
const startToStartOverlapZeroLag: ScheduleEdge = {
  processId: 5,
  predecessorId: 4,
  type: "START_TO_START_WITH_OVERLAP",
  lagDays: 0,
};

// Mirror: a FINISH_TO_START edge with lagDays === 0 still demands COMPLETE —
// proving the check is type-keyed, not sign-keyed, in both directions.
const finishToStartZeroLag: ScheduleEdge = {
  processId: 6,
  predecessorId: 4,
  type: "FINISH_TO_START",
  lagDays: 0,
};

describe("assertCanStart", () => {
  const cases: { name: string; edge: ScheduleEdge; predecessorStatus: string; expected: string | null }[] = [
    { name: "FINISH_TO_START, predecessor COMPLETE", edge: finishToStart, predecessorStatus: "COMPLETE", expected: null },
    { name: "FINISH_TO_START, predecessor IN_PROGRESS", edge: finishToStart, predecessorStatus: "IN_PROGRESS", expected: ERROR_CODES.GATING_BLOCKED },
    { name: "FINISH_TO_START, predecessor NOT_STARTED", edge: finishToStart, predecessorStatus: "NOT_STARTED", expected: ERROR_CODES.GATING_BLOCKED },
    {
      name: "START_TO_START_WITH_OVERLAP (negative lag), predecessor only IN_PROGRESS — this is the legitimate concurrency case",
      edge: startToStartOverlap,
      predecessorStatus: "IN_PROGRESS",
      expected: null,
    },
    {
      name: "START_TO_START_WITH_OVERLAP, predecessor COMPLETE — starting late is always fine",
      edge: startToStartOverlap,
      predecessorStatus: "COMPLETE",
      expected: null,
    },
    {
      name: "START_TO_START_WITH_OVERLAP, predecessor NOT_STARTED — concurrency needs the predecessor to have begun",
      edge: startToStartOverlap,
      predecessorStatus: "NOT_STARTED",
      expected: ERROR_CODES.GATING_BLOCKED,
    },
    {
      name: "START_TO_START_WITH_OVERLAP, predecessor ON_HOLD is not \"started\" for gating purposes",
      edge: startToStartOverlap,
      predecessorStatus: "ON_HOLD",
      expected: ERROR_CODES.GATING_BLOCKED,
    },
    {
      name: "START_TO_START_WITH_OVERLAP with lagDays 0, predecessor only IN_PROGRESS — type-keyed, so this is still legitimate concurrency",
      edge: startToStartOverlapZeroLag,
      predecessorStatus: "IN_PROGRESS",
      expected: null,
    },
    {
      name: "FINISH_TO_START with lagDays 0, predecessor IN_PROGRESS — still demands COMPLETE (proves not sign-keyed)",
      edge: finishToStartZeroLag,
      predecessorStatus: "IN_PROGRESS",
      expected: ERROR_CODES.GATING_BLOCKED,
    },
  ];

  it.each(cases)("$name", ({ edge, predecessorStatus, expected }) => {
    const states: PredecessorState[] = [
      { predecessorId: edge.predecessorId, status: predecessorStatus as PredecessorState["status"] },
    ];
    expect(codeOf(() => assertCanStart([edge], states))).toBe(expected);
  });
});

describe("assertCanComplete — the invariant #11 regression case", () => {
  it("refuses completion of a negative-lag process while its predecessor is only IN_PROGRESS, even though it was legitimately allowed to start", () => {
    const states: PredecessorState[] = [{ predecessorId: 2, status: "IN_PROGRESS" }];
    // Confirms it was allowed to start concurrently in the first place.
    expect(codeOf(() => assertCanStart([startToStartOverlap], states))).toBeNull();
    // But it can never complete before P2 does, negative lag or not.
    expect(codeOf(() => assertCanComplete([startToStartOverlap], states))).toBe(
      ERROR_CODES.GATING_BLOCKED,
    );
  });

  it("allows completion once every predecessor is COMPLETE, negative-lag edges included", () => {
    const states: PredecessorState[] = [{ predecessorId: 2, status: "COMPLETE" }];
    expect(codeOf(() => assertCanComplete([startToStartOverlap], states))).toBeNull();
  });

  it("refuses completion on a positive-lag (FINISH_TO_START) edge the same way", () => {
    const states: PredecessorState[] = [{ predecessorId: 19, status: "SUBMITTED" }];
    expect(codeOf(() => assertCanComplete([finishToStart], states))).toBe(ERROR_CODES.GATING_BLOCKED);
  });

  it("blocks on ANY unmet predecessor when a process has several", () => {
    const edges: ScheduleEdge[] = [
      { processId: 10, predecessorId: 7, type: "START_TO_START_WITH_OVERLAP", lagDays: -3 },
      { processId: 10, predecessorId: 8, type: "FINISH_TO_START", lagDays: 4 },
      { processId: 10, predecessorId: 9, type: "FINISH_TO_START", lagDays: 11 },
    ];
    const states: PredecessorState[] = [
      { predecessorId: 7, status: "COMPLETE" },
      { predecessorId: 8, status: "COMPLETE" },
      { predecessorId: 9, status: "IN_PROGRESS" },
    ];
    const result = codeOf(() => assertCanComplete(edges, states));
    expect(result).toBe(ERROR_CODES.GATING_BLOCKED);
  });

  it("reports which predecessor(s) are blocking, for the UI's refusal message", () => {
    const edges: ScheduleEdge[] = [
      { processId: 10, predecessorId: 7, type: "START_TO_START_WITH_OVERLAP", lagDays: -3 },
      { processId: 10, predecessorId: 8, type: "FINISH_TO_START", lagDays: 4 },
    ];
    const states: PredecessorState[] = [
      { predecessorId: 7, status: "IN_PROGRESS" },
      { predecessorId: 8, status: "IN_PROGRESS" },
    ];
    try {
      assertCanComplete(edges, states);
      throw new Error("expected assertCanComplete to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).detail?.predecessorIds).toEqual([7, 8]);
    }
  });
});
