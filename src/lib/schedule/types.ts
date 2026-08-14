/**
 * Shared types for lib/schedule/. Deliberately decoupled from
 * @/generated/prisma — these are pure computation modules, testable without a
 * database, and the thin mapping to/from Prisma rows happens in the caller
 * (a future lib/services/schedule.ts, per CLAUDE.md's layering).
 */

export type EdgeType = "FINISH_TO_START" | "START_TO_START_WITH_OVERLAP";

/**
 * One process/stage in a template or job process spine (TemplateProcess /
 * JobProcess shape). `id` must be unique within the set passed to any
 * lib/schedule function.
 */
export interface ScheduleProcess {
  id: number;
  code: number | string;
  name: string;
  durationMinDays: number | null;
  durationMaxDays: number | null;
  envelopeFinishByMinDays: number | null;
  envelopeFinishByMaxDays: number | null;
  envelopeStartByMinDays: number | null;
  envelopeStartByMaxDays: number | null;
  /** See TemplateProcess.provisional in schema.prisma. */
  provisional: boolean;
}

/**
 * lagDays < 0 is legitimate concurrent work (predecessor need not finish
 * before this process starts), not a data error — BUILD-SPEC-v2 §1.3.
 */
export interface ScheduleEdge {
  processId: number;
  predecessorId: number;
  type: EdgeType;
  lagDays: number;
}

/** ISO weekday numbers: Monday=1 … Sunday=7 (JS Date#getDay() is 0=Sunday). */
export interface WorkCalendarInput {
  weekOffDays: number[];
  /** Non-working dates beyond the weekly off-day, e.g. a holiday list. */
  holidays?: Date[];
}

export type ProcessPlanStatusInput =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "COMPLETE"
  | "ON_HOLD";
