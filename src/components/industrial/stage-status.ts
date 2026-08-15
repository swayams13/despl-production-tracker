/**
 * Display-status vocabulary for the industrial UI — the six values a stage
 * segment / matrix cell / chip can show (DESIGN_SPEC §11.2 "fill" ladder).
 *
 * This is the *display* status, already rolled up. The rollup from the 36
 * ProcessPlan rows (5 enum states + derived overdue/rejected) to one of these
 * six lives in the SQL view `v_unit_stage_status` (built in §9 session 2);
 * these components only render what the rollup produced.
 */
export type StageDisplayStatus =
  | "complete"
  | "progress"
  | "submitted"
  | "hold"
  | "overdue"
  | "idle";

interface StatusMeta {
  /** chip class from the mockup (.c-complete …) */
  chipClass: string;
  /** CSS var holding the fill colour, for spine segments */
  colorVar: string;
  /** user-facing label — plain, sentence-adjacent, matches the mockup */
  label: string;
}

export const STAGE_STATUS: Record<StageDisplayStatus, StatusMeta> = {
  complete: { chipClass: "c-complete", colorVar: "var(--s-complete)", label: "Complete" },
  progress: { chipClass: "c-progress", colorVar: "var(--s-progress)", label: "In progress" },
  submitted: { chipClass: "c-submitted", colorVar: "var(--s-submitted)", label: "Awaiting QC" },
  hold: { chipClass: "c-hold", colorVar: "var(--s-hold)", label: "On hold" },
  overdue: { chipClass: "c-overdue", colorVar: "var(--s-overdue)", label: "Overdue" },
  idle: { chipClass: "c-idle", colorVar: "var(--s-idle)", label: "Not started" },
};

/** One segment of a stage spine: its fill status plus the secondary markers. */
export interface StageSegment {
  stageNo: number;
  stageName: string;
  status: StageDisplayStatus;
  /** overdue but not already the fill → renders the red corner pip (C26) */
  overdue?: boolean;
  /** has a rejected QC submission in history → distinct marker (not a fill colour) */
  rejected?: boolean;
  /** earliest not-complete backing plan (§11.3) — the action CTA routes here */
  governingPlanId?: number;
  /** the unit this segment's status/governingPlanId came from — set on job-level
   * (cross-unit) rollups so a click can still resolve to one real StageSheet target. */
  unitId?: number;
  serialNo?: string;
}

/** Should this segment show the rejected marker (distinct from the fill/overdue pip)? */
export function showsRejectedMarker(seg: Pick<StageSegment, "rejected">): boolean {
  return Boolean(seg.rejected);
}

/** Should this segment show the secondary overdue pip? (overdue, but fill isn't overdue) */
export function showsOverduePip(seg: Pick<StageSegment, "status" | "overdue">): boolean {
  return Boolean(seg.overdue) && seg.status !== "overdue";
}
