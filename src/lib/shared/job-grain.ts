import type { ProcessPlanStatus } from "@/generated/prisma/enums";

/**
 * Lean Core L1.3 (D5): the processes planned once per job, not once per unit: the office processes 1-11
 * and Documentation/MDR 33. A JOB-grain ProcessPlan has unitId = NULL and is shown on every unit.
 */
export const JOB_GRAIN_PROCESS_CODES: readonly string[] = [...Array.from({ length: 11 }, (_, i) => String(i + 1)), "33"];

export interface CollapsiblePlan {
  id: number;
  status: ProcessPlanStatus;
  actualStart: Date | null;
  actualFinish: Date | null;
  reportedStartAt: Date | null;
  reportedFinishAt: Date | null;
  submittedBy: number | null;
  verifiedBy: number | null;
}

export type Collapsed = Pick<CollapsiblePlan, "status" | "actualStart" | "actualFinish" | "reportedStartAt" | "reportedFinishAt" | "submittedBy" | "verifiedBy">;

const earliest = (ds: Array<Date | null>) => ds.filter((d): d is Date => d != null).reduce<Date | null>((a, d) => (a && a <= d ? a : d), null);
const latest = (ds: Array<Date | null>) => ds.filter((d): d is Date => d != null).reduce<Date | null>((a, d) => (a && a >= d ? a : d), null);

/** All submitted by one and the same person: the only case in which a collapsed plan can honestly stay SUBMITTED. */
function singleMaker(plans: readonly Pick<CollapsiblePlan, "status" | "submittedBy">[]): boolean {
  const makers = new Set(plans.map((p) => p.submittedBy));
  return makers.size === 1 && !makers.has(null);
}

/**
 * One JOB plan from a job's per-unit plans of the same process (reschedule carry-forward and the
 * backfill). Status: the shared status when all agree; else IN_PROGRESS if any unit has started, else
 * NOT_STARTED. COMPLETE only when every unit is. Earliest start, latest finish (finish only when COMPLETE).
 * Maker-checker (invariant 3): a collapsed plan is SUBMITTED only when every unit was submitted by the SAME
 * person, who stays its maker. Units submitted by different people go back to IN_PROGRESS to be submitted
 * again: keeping one of the makers would let another maker verify their own work.
 */
export function collapseUnitPlans(plans: readonly CollapsiblePlan[]): Collapsed {
  const sorted = [...plans].sort((a, b) => a.id - b.id);
  const statuses = new Set(sorted.map((p) => p.status));
  let status: ProcessPlanStatus =
    statuses.size === 1 ? sorted[0].status : statuses.size === 0 || [...statuses].every((s) => s === "NOT_STARTED") ? "NOT_STARTED" : "IN_PROGRESS";
  if (status === "SUBMITTED" && !singleMaker(sorted)) status = "IN_PROGRESS";
  const done = status === "COMPLETE";
  return {
    status,
    actualStart: earliest(sorted.map((p) => p.actualStart)),
    actualFinish: done ? latest(sorted.map((p) => p.actualFinish)) : null,
    reportedStartAt: earliest(sorted.map((p) => p.reportedStartAt)),
    reportedFinishAt: done ? latest(sorted.map((p) => p.reportedFinishAt)) : null,
    submittedBy: status === "SUBMITTED" ? sorted[0].submittedBy : done ? (sorted.find((p) => p.submittedBy != null)?.submittedBy ?? null) : null,
    verifiedBy: done ? (sorted.find((p) => p.verifiedBy != null)?.verifiedBy ?? null) : null,
  };
}

/**
 * A state the collapse would flatten to IN_PROGRESS while a unit is waiting on QC or on hold, or units submitted
 * by different people: the backfill skips it and reports it.
 */
export function isRiskyMix(plans: readonly Pick<CollapsiblePlan, "status" | "submittedBy">[]): boolean {
  const s = new Set(plans.map((p) => p.status));
  if (s.size > 1 && (s.has("SUBMITTED") || s.has("ON_HOLD"))) return true;
  return s.size === 1 && s.has("SUBMITTED") && !singleMaker(plans);
}

const ADVANCE: Record<ProcessPlanStatus, number> = { NOT_STARTED: 0, IN_PROGRESS: 1, ON_HOLD: 1, SUBMITTED: 2, COMPLETE: 3 };

/**
 * A predecessor process's status as seen from a plan on `unitId`: that unit's own plan, else the job's
 * unit-less (JOB-grain) plan; from a unit-less plan, the job-level plan, else the least advanced unit
 * (a job-level step waits for every unit). No plan at all reads NOT_STARTED, as before.
 */
export function predecessorStatus(
  plans: ReadonlyArray<{ unitId: number | null; status: ProcessPlanStatus }>,
  unitId: number | null,
): ProcessPlanStatus {
  const jobLevel = plans.find((p) => p.unitId == null);
  if (unitId != null) return plans.find((p) => p.unitId === unitId)?.status ?? jobLevel?.status ?? "NOT_STARTED";
  if (jobLevel) return jobLevel.status;
  return plans.reduce<ProcessPlanStatus | null>((least, p) => (least == null || ADVANCE[p.status] < ADVANCE[least] ? p.status : least), null) ?? "NOT_STARTED";
}
