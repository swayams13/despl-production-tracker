import { DEFAULT_CALENDAR, isWorkingDay } from "@/lib/schedule/calendar";
import type { WorkCalendarInput } from "@/lib/schedule/types";
import { IST_OFFSET_MS, istCalendarDayMarker } from "./business-day";
import type { ErrorCode } from "./errors";

/**
 * Lean Core L1.2 floor rules: D2 (sequence gating), D3 (requiresQc), D4
 * (reportedAt window) and D12 (H-point scope), as recorded in CLAUDE.md on
 * 14 Oct 2026. Pure — no Prisma, no DB. The facts are loaded once per unit by
 * work.facts.ts (L1.2d) and updated in memory after each applied item.
 *
 * D2 and D12 are provisional: SJ and the QC head may change rule text, which
 * is why every HARD rule lives in this one registry.
 */

export type WorkKind = "COMPONENT_OP" | "ASSEMBLY_STEP" | "PROCESS_PLAN";
export type ItemStatus = "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "COMPLETE" | "ON_HOLD";
/** Mirrors the AssemblyStepRole enum added in L1.2b. */
export type AssemblyRole = "FIT_UP" | "WELD" | "NDT" | "HEAT_TREATMENT" | "FINAL_PWHT" | "HYDRO";
/** AT_RISK = released at risk by the Production Head (H3). NO_LINK = no governing drawing (data gap, H3 no-op). */
export type DrawingState = "RELEASED" | "AT_RISK" | "NOT_RELEASED" | "NO_LINK";

/**
 * H3 state of a governing drawing from its CURRENT (highest revisionNo)
 * revision. An at-risk release belongs to one revision row, so a newer
 * revision (no at-risk fields) voids it by becoming current.
 */
export function drawingStateOf(
  current: { status: string; atRiskReleasedAt: Date | null } | null | undefined,
  linked = true,
): DrawingState {
  if (!linked) return "NO_LINK";
  if (!current) return "NOT_RELEASED";
  if (current.status === "RELEASED") return "RELEASED";
  return current.atRiskReleasedAt ? "AT_RISK" : "NOT_RELEASED";
}

interface ItemBase {
  id: number;
  status: ItemStatus;
  /** TemplateProcess.seq the item maps to (36-process spine), if any. */
  processSeq: number | null;
  /** An uncleared blocking H point recorded against this item (D12). */
  openBlockingHold: boolean;
}
export interface StepItem extends ItemBase {
  kind: "ASSEMBLY_STEP";
  /** AssemblyStep.seq — job-level, unique per unit. */
  seq: number;
  stepKind: "WORK" | "INSPECTION";
  role: AssemblyRole | null;
  /** One joint, or several separated by commas (nozzle welds). */
  jointRef: string | null;
  pressurePart: boolean;
}
export interface OpItem extends ItemBase {
  kind: "COMPONENT_OP";
  componentId: number;
  routeSeq: number;
  /** OperationRef.code: CUTTING, FIT_UP, WELDING, NDT, PAINTING, … */
  opCode: string;
  pressureRetaining: boolean;
  materialIssued: boolean;
  heatPicked: boolean;
  drawing: DrawingState;
}
export interface PlanItem extends ItemBase {
  kind: "PROCESS_PLAN";
}
export type FloorItem = StepItem | OpItem | PlanItem;

export type RuleCode = "H5" | "H6";

export interface UnitFacts {
  /** Every assembly step, component op and process plan of the unit (plus the job's JOB-grain plans). */
  items: FloorItem[];
  /** TemplateProcess.seq values excluded from the job at intake. */
  excludedProcessSeqs: number[];
  /** D2: false for in-flight imports and legacy jobs — HARD rules only, no SOFT gating. */
  hasAssemblySequence: boolean;
  /** H5/H6 NCRs dispositioned "accept per code exception": each exempts only its own target. */
  concessions: Array<{ rule: RuleCode; kind: WorkKind; id: number }>;
}

export interface RuleRefusal {
  code: ErrorCode;
  meta: Record<string, unknown>;
}

export interface HardRule {
  id: "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "HOLD_LINK" | "PAINT_AFTER_HYDRO";
  /** Earlier items this rule orders the item after; SOFT never double-counts them. */
  linked(item: FloorItem, facts: UnitFacts): FloorItem[];
  check(item: FloorItem, facts: UnitFacts): RuleRefusal | null;
}

export const PWHT_PROCESS_SEQ = 21;
export const HYDRO_PROCESS_SEQ = 27;
const PAINT_PROCESS_SEQS = [29, 30];
/** D2: processes 1–11 are planning/procurement order, job grain, SOFT. */
export const OFFICE_PROCESS_MAX_SEQ = 11;

/** H1 default (14 Oct): a predecessor counts as done once submitted; real holds come through D12. */
const isDone = (i: FloorItem) => i.status === "SUBMITTED" || i.status === "COMPLETE";
const steps = (f: UnitFacts) => f.items.filter((i): i is StepItem => i.kind === "ASSEMBLY_STEP");
const ops = (f: UnitFacts) => f.items.filter((i): i is OpItem => i.kind === "COMPONENT_OP");
const ref = (i: FloorItem) => ({ kind: i.kind, id: i.id });

const joints = (s: StepItem) => (s.jointRef ?? "").split(",").map((j) => j.trim()).filter(Boolean);
const shareJoint = (a: StepItem, b: StepItem) => joints(a).some((j) => joints(b).includes(j));

const H1_RANK: Partial<Record<AssemblyRole, number>> = { FIT_UP: 0, WELD: 1, NDT: 2 };
function jointPredecessors(item: FloorItem, facts: UnitFacts): StepItem[] {
  if (item.kind !== "ASSEMBLY_STEP" || !item.role || H1_RANK[item.role] === undefined) return [];
  const rank = H1_RANK[item.role]!;
  return steps(facts).filter(
    (s) => s.id !== item.id && s.role && (H1_RANK[s.role] ?? 99) < rank && shareJoint(s, item),
  );
}

/** "Welding" for H5/H6 = fit-up + weld on a pressure part (D2: tack welds fuse too). */
function isPressureWelding(item: FloorItem): boolean {
  if (item.kind === "ASSEMBLY_STEP") return item.pressurePart && (item.role === "FIT_UP" || item.role === "WELD");
  if (item.kind === "COMPONENT_OP") return item.pressureRetaining && (item.opCode === "FIT_UP" || item.opCode === "WELDING");
  return false;
}
const isPressureCutting = (item: FloorItem): item is OpItem =>
  item.kind === "COMPONENT_OP" && item.opCode === "CUTTING" && item.pressureRetaining;

const included = (facts: UnitFacts, seq: number) => !facts.excludedProcessSeqs.includes(seq);
const finalPwhtSteps = (facts: UnitFacts) =>
  included(facts, PWHT_PROCESS_SEQ) ? steps(facts).filter((s) => s.role === "FINAL_PWHT") : [];
const hydroSteps = (facts: UnitFacts) => steps(facts).filter((s) => s.role === "HYDRO");
const hasConcession = (facts: UnitFacts, rule: RuleCode, item: FloorItem) =>
  facts.concessions.some((c) => c.rule === rule && c.kind === item.kind && c.id === item.id);

function hydroPrerequisites(facts: UnitFacts): FloorItem[] {
  return facts.items.filter(
    (i) =>
      (i.kind === "ASSEMBLY_STEP" && i.pressurePart && (i.role === "WELD" || i.role === "NDT")) ||
      (i.kind === "COMPONENT_OP" && i.pressureRetaining && (i.opCode === "WELDING" || i.opCode === "NDT")),
  );
}
function hydroComplete(facts: UnitFacts): boolean {
  return facts.items.some(
    (i) =>
      i.status === "COMPLETE" &&
      ((i.kind === "ASSEMBLY_STEP" && i.role === "HYDRO") || (i.kind === "PROCESS_PLAN" && i.processSeq === HYDRO_PROCESS_SEQ)),
  );
}
const isHydro = (item: FloorItem) => item.kind === "ASSEMBLY_STEP" && item.role === "HYDRO";
const none = () => [];

/** Evaluated in this order at START (including the implicit START of a DONE on a NOT_STARTED item); the first refusal wins. */
export const HARD_RULES: HardRule[] = [
  {
    id: "H1",
    linked: jointPredecessors,
    check(item, facts) {
      const open = jointPredecessors(item, facts).filter((s) => !isDone(s));
      return open.length ? { code: "JOINT_SEQUENCE_BLOCKED", meta: { rule: "H1", open: open.map(ref) } } : null;
    },
  },
  {
    // D12: an open blocking H point blocks the next HARD-linked step on the same joint or part.
    id: "HOLD_LINK",
    linked: none,
    check(item, facts) {
      const held =
        item.kind === "COMPONENT_OP"
          ? ops(facts).filter((o) => o.componentId === item.componentId && o.routeSeq < item.routeSeq && o.openBlockingHold)
          : jointPredecessors(item, facts).filter((s) => s.openBlockingHold);
      return held.length ? { code: "HOLD_POINT_OPEN", meta: { rule: "HOLD_LINK", held: held.map(ref) } } : null;
    },
  },
  {
    id: "H2",
    linked: none,
    check(item) {
      if (!isPressureCutting(item)) return null;
      if (!item.materialIssued) return { code: "MATERIAL_NOT_ISSUED", meta: { rule: "H2" } };
      if (!item.heatPicked) return { code: "HEAT_NUMBER_NOT_PICKED", meta: { rule: "H2" } };
      return null;
    },
  },
  {
    // NO_LINK is a no-op here and reported by h3DataGaps. Non-pressure parts have no drawing gate.
    id: "H3",
    linked: none,
    check(item) {
      return isPressureCutting(item) && item.drawing === "NOT_RELEASED"
        ? { code: "DRAWING_NOT_RELEASED", meta: { rule: "H3" } }
        : null;
    },
  },
  {
    id: "H4",
    linked: (item, facts) => (isHydro(item) ? finalPwhtSteps(facts) : []),
    check(item, facts) {
      if (!isHydro(item)) return null;
      const open = finalPwhtSteps(facts).filter((s) => s.status !== "COMPLETE");
      return open.length ? { code: "PWHT_NOT_COMPLETE", meta: { rule: "H4", open: open.map(ref) } } : null;
    },
  },
  {
    // Only the final PWHT triggers it (PFHT = HEAT_TREATMENT does not); local PWHT locks the whole unit.
    id: "H5",
    linked: none,
    check(item, facts) {
      if (!isPressureWelding(item) || hasConcession(facts, "H5", item)) return null;
      return finalPwhtSteps(facts).some((s) => s.status !== "NOT_STARTED")
        ? { code: "WELD_AFTER_PWHT", meta: { rule: "H5", routeTo: "NCR" } }
        : null;
    },
  },
  {
    id: "H6",
    linked: (item, facts) => (isHydro(item) ? hydroPrerequisites(facts) : []),
    check(item, facts) {
      if (isHydro(item)) {
        const open = hydroPrerequisites(facts).filter((i) => i.status !== "COMPLETE");
        return open.length ? { code: "HYDRO_PREREQUISITES_INCOMPLETE", meta: { rule: "H6", open: open.map(ref) } } : null;
      }
      if (!isPressureWelding(item) || hasConcession(facts, "H6", item)) return null;
      return hydroSteps(facts).some((s) => s.status !== "NOT_STARTED")
        ? { code: "WELD_AFTER_HYDRO", meta: { rule: "H6", routeTo: "NCR" } }
        : null;
    },
  },
  {
    // Invariant 2, always HARD: 29 and 30 need 27 complete.
    id: "PAINT_AFTER_HYDRO",
    linked: none,
    check(item, facts) {
      return item.processSeq !== null && PAINT_PROCESS_SEQS.includes(item.processSeq) && !hydroComplete(facts)
        ? { code: "PAINT_BEFORE_HYDRO", meta: { rule: "PAINT_AFTER_HYDRO" } }
        : null;
    },
  },
];

export function evaluateHard(item: FloorItem, facts: UnitFacts): (RuleRefusal & { rule: HardRule["id"] }) | null {
  for (const rule of HARD_RULES) {
    const r = rule.check(item, facts);
    if (r) return { ...r, rule: rule.id };
  }
  return null;
}

/**
 * D2 SOFT: the open earlier items that no HARD rule links to this one.
 * Assembly steps: earlier WORK steps by AssemblyStep.seq (INSPECTION excluded).
 * Component ops: earlier ops on the same component's route.
 * Processes 1–11: earlier office processes.
 */
export function evaluateSoft(item: FloorItem, facts: UnitFacts): FloorItem[] {
  if (!facts.hasAssemblySequence) return [];
  let earlier: FloorItem[];
  if (item.kind === "ASSEMBLY_STEP") {
    earlier = steps(facts).filter((s) => s.stepKind === "WORK" && s.seq < item.seq);
  } else if (item.kind === "COMPONENT_OP") {
    earlier = ops(facts).filter((o) => o.componentId === item.componentId && o.routeSeq < item.routeSeq);
  } else if (item.processSeq !== null && item.processSeq <= OFFICE_PROCESS_MAX_SEQ) {
    const seq = item.processSeq;
    earlier = facts.items.filter((p) => p.kind === "PROCESS_PLAN" && p.processSeq !== null && p.processSeq < seq);
  } else {
    return [];
  }
  const linked = new Set(HARD_RULES.flatMap((r) => r.linked(item, facts)));
  return earlier.filter((e) => !isDone(e) && !linked.has(e));
}

/** D2 override authority: Supervisor and Production Head; Planner for processes 1–11. Never Admin alone, never Operator. */
export function canOverride(roles: readonly string[], item: FloorItem): boolean {
  if (roles.includes("SUPERVISOR") || roles.includes("PRODUCTION_HEAD")) return true;
  return (
    roles.includes("PLANNER") &&
    item.kind === "PROCESS_PLAN" &&
    item.processSeq !== null &&
    item.processSeq <= OFFICE_PROCESS_MAX_SEQ
  );
}

export type StartCheck =
  | { ok: true; overridden: FloorItem[] }
  | { ok: false; code: ErrorCode; meta: Record<string, unknown> };

/** HARD first (no override), then SOFT (override reason from a Supervisor or above). */
export function checkStart(
  item: FloorItem,
  facts: UnitFacts,
  actor: { roles: readonly string[]; hasOverride: boolean },
): StartCheck {
  const hard = evaluateHard(item, facts);
  if (hard) return { ok: false, code: hard.code, meta: hard.meta };
  const open = evaluateSoft(item, facts);
  if (!open.length) return { ok: true, overridden: [] };
  const allowed = canOverride(actor.roles, item);
  if (!allowed || !actor.hasOverride) {
    return { ok: false, code: "SEQUENCE_OVERRIDE_REQUIRED", meta: { canOverride: allowed, open: open.map(ref) } };
  }
  return { ok: true, overridden: open };
}

/** H3 data gaps: pressure-part cutting ops with no governing drawing link (H3 cannot gate them). */
export function h3DataGaps(facts: UnitFacts): OpItem[] {
  return ops(facts).filter((o) => isPressureCutting(o) && o.drawing === "NO_LINK");
}

// ---------------------------------------------------------------------------
// D4: reportedAt window
// ---------------------------------------------------------------------------

export const BACKDATE_WINDOW_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Hours in [from, to) that fall on a working day of `calendar`, every IST day
 * counting all 24 h. calendar.ts works on UTC-midnight date markers, so each
 * IST day is converted to that marker before asking isWorkingDay.
 *
 * Bounded (`from` can be client input): walks back from `to` and stops once
 * more than `stopAfterHours` are counted, or after MAX_WALK_DAYS days, which
 * returns Infinity (further back than any window this is asked about).
 */
const MAX_WALK_DAYS = 400;
export function workingHoursBetween(
  from: Date,
  to: Date,
  calendar: WorkCalendarInput = DEFAULT_CALENDAR,
  stopAfterHours = Infinity,
): number {
  let ms = 0;
  let cursor = to.getTime();
  for (let days = 0; cursor > from.getTime(); days++) {
    if (days === MAX_WALK_DAYS) return Infinity;
    if (ms > stopAfterHours * HOUR_MS) break;
    const day = istCalendarDayMarker(new Date(cursor - 1));
    const start = Math.max(day.getTime() - IST_OFFSET_MS, from.getTime());
    if (isWorkingDay(day, calendar)) ms += cursor - start;
    cursor = start;
  }
  return ms / HOUR_MS;
}

export type ReportedAtProblem = "FUTURE" | "TOO_OLD" | "BEFORE_RELEASE" | "DONE_BEFORE_START";

/**
 * null when `reportedAt` is acceptable. Lower bound: the job's release date
 * (earliest RELEASED BOM revision), else its order date, else the window only;
 * compared by IST calendar day, since the order date is a date marker.
 */
export function checkReportedAt(input: {
  reportedAt: Date;
  now: Date;
  action: "START" | "DONE";
  releaseDate: Date | null;
  orderDate: Date | null;
  /** COALESCE(reportedStartAt, actualStart) of the item, for DONE. */
  startedAt?: Date | null;
  calendar?: WorkCalendarInput;
}): ReportedAtProblem | null {
  const { reportedAt, now } = input;
  if (reportedAt.getTime() > now.getTime()) return "FUTURE";
  const floor = input.releaseDate ?? input.orderDate;
  if (floor && istCalendarDayMarker(reportedAt) < istCalendarDayMarker(floor)) return "BEFORE_RELEASE";
  if (input.action === "DONE" && input.startedAt && reportedAt < input.startedAt) return "DONE_BEFORE_START";
  if (workingHoursBetween(reportedAt, now, input.calendar, BACKDATE_WINDOW_HOURS) > BACKDATE_WINDOW_HOURS) return "TOO_OLD";
  return null;
}

// ---------------------------------------------------------------------------
// D3: requiresQc, derived by rule
// ---------------------------------------------------------------------------

export interface RequiresQcInput {
  kind: WorkKind;
  stepKind?: "WORK" | "INSPECTION";
  role?: AssemblyRole | null;
  opCode?: string;
  processSeq?: number | null;
  /** Linked to a QCP point of any party (H, W, R, RW, R&A). */
  qcpLinked: boolean;
  /** pressurePart (step) or pressureRetaining (op). */
  pressure: boolean;
  /** Final dimensional or name-plate stamping record (no role or op code names these yet). */
  testRecord?: boolean;
}

const TEST_ROLES: AssemblyRole[] = ["HEAT_TREATMENT", "FINAL_PWHT", "HYDRO"];

/** D3. `reason` is what the QC head reviews on the derived list. */
export function deriveRequiresQc(i: RequiresQcInput): { requiresQc: boolean; reason: string } {
  if (i.stepKind === "INSPECTION") return { requiresQc: false, reason: "QC inspection step (checker of the work step)" };
  if (i.kind === "PROCESS_PLAN" && i.processSeq != null && i.processSeq <= OFFICE_PROCESS_MAX_SEQ) {
    return { requiresQc: false, reason: "office process 1–11" };
  }
  if (i.qcpLinked) return { requiresQc: true, reason: "linked to a QCP point" };
  if (i.pressure && (i.role === "FIT_UP" || i.role === "WELD" || i.opCode === "FIT_UP" || i.opCode === "WELDING")) {
    return { requiresQc: true, reason: "fit-up or welding on a pressure-retaining joint" };
  }
  if (i.pressure && i.opCode === "CUTTING") return { requiresQc: true, reason: "heat-number transfer at cutting of a pressure part" };
  if ((i.role && TEST_ROLES.includes(i.role)) || i.opCode === "PAINTING" || i.testRecord) {
    return { requiresQc: true, reason: "test or treatment record" };
  }
  return { requiresQc: false, reason: "no QC trigger (handling, non-pressure, preparation)" };
}
