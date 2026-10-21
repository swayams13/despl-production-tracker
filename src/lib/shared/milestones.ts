/**
 * Lean Core J8 (D9): the company-wide milestones and how a job's process plans
 * roll up to them. Pure: no React, no database.
 *
 * Progress is weighted by PLANNED EFFORT (mapping weight, else the process's
 * maximum duration in days). That is a weighting between milestones, never a
 * schedule: nothing here sums durations into dates (invariant 10). A plan is
 * worth its full effort when COMPLETE and nothing otherwise; there is no partial
 * credit for IN_PROGRESS or SUBMITTED, so a bar never promises work QC has not
 * accepted.
 */

/** D9 default names (build prompt §8.4). SJ and the MD ratify. */
export const D9_MILESTONES = [
  { code: "ENG", name: "Engineering approved" },
  { code: "MAT", name: "Material ready" },
  { code: "CUT", name: "Cutting & forming" },
  { code: "FAB", name: "Fabrication" },
  { code: "NDT", name: "NDT" },
  { code: "PWHT", name: "PWHT" },
  { code: "TEST", name: "Pressure test" },
  { code: "PAINT", name: "Painting" },
  { code: "DOC", name: "Documentation" },
  { code: "DISP", name: "Dispatched" },
] as const;

/**
 * PROVISIONAL pressure-vessel map, by process code of `seed/lead-time-model.json`
 * (36 processes). Derived from the process names; ratify with SJ and the MD (D9).
 */
export const PV_MILESTONE_MAP: Record<string, string> = {
  ...Object.fromEntries(["1", "2", "3", "4", "5"].map((c) => [c, "ENG"])), // PO review, kick-off, calculation, drawings, client approval
  ...Object.fromEntries(["6", "7", "8", "9", "10", "11"].map((c) => [c, "MAT"])), // BOM/MTO, procurement, receipt, traceability
  ...Object.fromEntries(["12", "13", "14"].map((c) => [c, "CUT"])), // cutting, forming/rolling, machining
  ...Object.fromEntries(["15", "16", "18", "19", "20", "23", "24", "25", "26"].map((c) => [c, "FAB"])), // fit-up, welding, nozzles, attachments, assembly, dimensional and visual checks
  ...Object.fromEntries(["17", "22"].map((c) => [c, "NDT"])),
  "21": "PWHT",
  ...Object.fromEntries(["27", "28"].map((c) => [c, "TEST"])), // hydro, draining and drying
  ...Object.fromEntries(["29", "30", "31", "32"].map((c) => [c, "PAINT"])), // surface prep, painting, final inspection, name plate
  "33": "DOC",
  ...Object.fromEntries(["34", "35", "36"].map((c) => [c, "DISP"])), // packing, dispatch clearance, dispatch
};

export interface MilestoneDef {
  id: number;
  code: string;
  name: string;
  sortOrder: number;
}

/** Family map entry, keyed by process code. */
export interface MilestoneMapEntry {
  milestoneId: number;
  weight: number | null;
}

/** One process plan of the job (one per unit for UNIT grain, one for JOB grain). */
export interface MilestonePlanFact {
  processCode: string;
  /** The process's maximum duration; null on a provisional process. */
  durationDays: number | null;
  status: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "COMPLETE" | "ON_HOLD";
  plannedFinish: Date | null;
}

export type MilestoneState = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE";

export interface MilestoneProgress extends MilestoneDef {
  plans: number;
  donePlans: number;
  /** Whole percent by effort; always 0..100 (a milestone with no plans is not listed). */
  percent: number;
  state: MilestoneState;
  /** Latest planned finish of the mapped plans, ISO date (YYYY-MM-DD); null when none is scheduled. */
  plannedFinish: string | null;
  /** Past its planned finish and not complete. */
  late: boolean;
}

export interface JobMilestones {
  /** Milestones that have at least one plan on this job, in order. Empty when the family has no map. */
  milestones: MilestoneProgress[];
  /** First milestone not complete; null when every listed one is complete or none is listed. */
  current: MilestoneProgress | null;
  /** The family has no work-order stage list (an exchanger today): the board and spine show milestones instead. */
  noStageList: boolean;
  /** Plans whose process code the family map does not cover (counted, never dropped silently). */
  unmappedPlans: number;
}

/** Effort of one plan: the mapping weight, else the process max duration, else 1 (a provisional process still counts). */
export const planEffort = (entry: MilestoneMapEntry, durationDays: number | null): number =>
  entry.weight ?? (durationDays != null && durationDays > 0 ? durationDays : 1);

export function rollupMilestones(
  defs: readonly MilestoneDef[],
  map: ReadonlyMap<string, MilestoneMapEntry>,
  plans: readonly MilestonePlanFact[],
  now: Date,
): Pick<JobMilestones, "milestones" | "current" | "unmappedPlans"> {
  const byMilestone = new Map<number, { effort: number; done: number; plans: number; doneN: number; started: boolean; finish: Date | null }>();
  let unmappedPlans = 0;
  for (const p of plans) {
    const entry = map.get(p.processCode);
    if (!entry) {
      unmappedPlans++;
      continue;
    }
    const a = byMilestone.get(entry.milestoneId) ?? { effort: 0, done: 0, plans: 0, doneN: 0, started: false, finish: null };
    const w = planEffort(entry, p.durationDays);
    a.effort += w;
    a.plans++;
    if (p.status === "COMPLETE") {
      a.done += w;
      a.doneN++;
    }
    if (p.status !== "NOT_STARTED") a.started = true;
    if (p.plannedFinish && (!a.finish || p.plannedFinish > a.finish)) a.finish = p.plannedFinish;
    byMilestone.set(entry.milestoneId, a);
  }

  const milestones: MilestoneProgress[] = [...defs]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .flatMap((d) => {
      const a = byMilestone.get(d.id);
      if (!a) return [];
      const state: MilestoneState = a.doneN === a.plans ? "COMPLETE" : a.started ? "IN_PROGRESS" : "NOT_STARTED";
      return [
        {
          ...d,
          plans: a.plans,
          donePlans: a.doneN,
          percent: Math.round((100 * a.done) / a.effort),
          state,
          plannedFinish: a.finish ? a.finish.toISOString().slice(0, 10) : null,
          late: state !== "COMPLETE" && a.finish != null && a.finish < now,
        },
      ];
    });
  return { milestones, current: milestones.find((m) => m.state !== "COMPLETE") ?? null, unmappedPlans };
}

/** "Fabrication 40%": the Portfolio cell and the digest line. */
export const milestoneLabel = (m: Pick<MilestoneProgress, "name" | "percent">): string => `${m.name} ${m.percent}%`;

/** The Portfolio cell: the current milestone, "All milestones done", or null (no milestone map for the family). */
export const portfolioMilestoneText = (r: { currentMilestone: MilestoneProgress | null; milestonesComplete: boolean }): string | null =>
  r.currentMilestone ? milestoneLabel(r.currentMilestone) : r.milestonesComplete ? "All milestones done" : null;
