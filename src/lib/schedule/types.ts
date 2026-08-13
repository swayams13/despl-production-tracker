/**
 * Inputs and outputs for the scheduling engine.
 *
 * These are plain data, deliberately NOT Prisma types. `lib/schedule/` computes
 * and never touches the database — `lib/services/` loads rows, calls in here,
 * and persists `ScheduleRun` / `ProcessPlan` transactionally with its audit row.
 * Keeping the engine pure is what makes the whole two-layer model testable
 * against hand-checked numbers instead of a seeded database.
 */

export type ProcessEdgeType = "FINISH_TO_START" | "START_TO_START_WITH_OVERLAP";

export type ScheduleFeasibility = "FEASIBLE" | "TIGHT" | "INFEASIBLE";

/** Mirrors the schedulable fields of `JobProcess` (and `TemplateProcess`). */
export interface ScheduleProcess {
  /** Process code, e.g. "1".."36" for Pressure Vessel. Unique within a job. */
  readonly code: string;
  readonly name: string;
  readonly seq: number;
  /** `false` = this client skips the process; it is bypassed, not zero-length. */
  readonly included: boolean;
  /** No confirmed lead time (e.g. PIPE_SPOOL, derived from a QAP, not a table). */
  readonly provisional: boolean;
  readonly durationMinDays: number | null;
  readonly durationMaxDays: number | null;
  /** Planner override; wins over `durationMaxDays` when set. */
  readonly durationOverrideDays: number | null;
  readonly envelopeFinishByMinDays: number | null;
  readonly envelopeFinishByMaxDays: number | null;
}

/**
 * A dependency. The uniform constraint for BOTH types is:
 *
 *     start(process) >= finish(predecessor) + lagDays
 *
 * `type` classifies the sign rather than selecting a different formula:
 * `lagDays >= 0` is FINISH_TO_START, `lagDays < 0` is
 * START_TO_START_WITH_OVERLAP (legitimate concurrent fabrication — 23 of the
 * 36 Pressure Vessel edges are negative, and BUILD-SPEC-v2 §1.3 fitted them to
 * the printed envelope on purpose).
 *
 * Verified: running this rule forward with max durations reproduces every one
 * of the 36 seeded envelope values exactly, terminal included (119 days).
 */
export interface ScheduleEdge {
  readonly processCode: string;
  readonly predecessorCode: string;
  readonly type: ProcessEdgeType;
  readonly lagDays: number;
}

/** Day-offsets from the project anchor, before any calendar is applied. */
export interface ProcessOffsets {
  readonly startOffset: number;
  readonly finishOffset: number;
}

/** A scheduled process with real dates. */
export interface PlannedProcess {
  readonly code: string;
  readonly name: string;
  readonly seq: number;
  readonly start: Date;
  readonly finish: Date;
  readonly startOffset: number;
  readonly finishOffset: number;
}

export interface FeasibilityResult {
  readonly feasibility: ScheduleFeasibility;
  /** Working days between the PO date and the required delivery date. */
  readonly availableDays: number;
  /** Terminal `envelopeFinishByMinDays` — the optimistic envelope. */
  readonly requiredMinDays: number;
  /** Terminal `envelopeFinishByMaxDays` — the standard envelope. */
  readonly requiredMaxDays: number;
  /** Working days short when INFEASIBLE, measured against the optimistic
   *  envelope (`requiredMinDays - availableDays`). Null otherwise. */
  readonly shortfallDays: number | null;
}
