import { computeCpm, type CpmNode } from "./cpm";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { ScheduleEdge, ScheduleProcess } from "./types";

/**
 * Planner override (BUILD-SPEC-v2 §1.4, CLAUDE.md invariant #6): any planned
 * date may be edited by an authorised planner, but only with a mandatory
 * reason, and never by mutating the baseline.
 *
 * This module owns the *computation* — mandatory-reason enforcement and
 * recomputing the downstream plan from a duration override, never touching
 * its inputs. Persisting the result (a new ScheduleRun version, the
 * DelayReason/audit_log row) is lib/services' job once that layer exists —
 * this stays a pure function so it is testable without a database, per how
 * every other lib/schedule module is built.
 */

export interface OverrideRequest {
  processId: number;
  durationOverrideDays: number;
  reason: string;
}

export interface OverridePlan {
  /** The plan before this override — untouched, a distinct object from `current`. */
  baseline: CpmNode[];
  /** The recomputed plan with this override (and any prior ones) applied. */
  current: CpmNode[];
  overriddenProcessId: number;
  reason: string;
}

function assertReasonProvided(reason: string): void {
  if (!reason || reason.trim().length === 0) {
    throw new AppError(ERROR_CODES.OVERRIDE_REASON_REQUIRED);
  }
}

/**
 * Apply a single duration override on top of any prior overrides
 * (`priorDurationOverrides`), returning both the pre-override baseline and
 * the recomputed current plan. Callers chain overrides by passing the
 * previous call's accumulated override map back in — never by discarding
 * the baseline.
 */
export function applyOverride(
  processes: ScheduleProcess[],
  edges: ScheduleEdge[],
  request: OverrideRequest,
  priorDurationOverrides: ReadonlyMap<number, number> = new Map(),
): OverridePlan {
  assertReasonProvided(request.reason);

  const baseline = computeCpm(processes, edges, {
    durationDaysByProcessId: new Map(priorDurationOverrides),
  });

  const nextOverrides = new Map(priorDurationOverrides);
  nextOverrides.set(request.processId, request.durationOverrideDays);
  const current = computeCpm(processes, edges, { durationDaysByProcessId: nextOverrides });

  return { baseline, current, overriddenProcessId: request.processId, reason: request.reason };
}
