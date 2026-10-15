/**
 * Lean Core L2.4: the pure parts of the Job board. `deriveCell` turns one
 * unit x stage's facts into the value printed in its cell (frame 03A);
 * `parseBoardFilter` / `applyBoardFilter` are the URL-driven chips. No React,
 * no database, so both are table-testable.
 */

export type BoardStatus = "complete" | "progress" | "submitted" | "hold" | "overdue" | "idle";

export interface CellFacts {
  status: BoardStatus;
  /** The job has at least one backing plan for this stage on this unit. */
  hasPlans: boolean;
  /** Rejected (open NCR / QC reject): a marker, never a value. */
  rejected: boolean;
  /** ISO of the latest actual finish, once every backing plan is complete. */
  doneAt: string | null;
  /** ISO of the planned finish of what is still open. */
  plannedAt: string | null;
  /** Calendar days past plannedAt, for an overdue cell. */
  daysLate: number | null;
  /** Mapped steps / ops COMPLETE or SUBMITTED, over all mapped to this stage on this unit. */
  itemsDone: number;
  itemsTotal: number;
  /** A SequenceOverride row exists on an item of this stage on this unit. */
  outOfSequence: boolean;
}

export interface CellView {
  status: BoardStatus;
  /** The stage has at least one process on this unit; false = a dash. */
  hasPlans: boolean;
  value: string;
  rejected: boolean;
  outOfSequence: boolean;
  /** Screen-reader sentence for the cell button. */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Feb" in IST. */
export function fmtDay(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`;
}

const STATUS_WORD: Record<BoardStatus, string> = {
  complete: "complete",
  progress: "in progress",
  submitted: "waiting for QC",
  hold: "on hold",
  overdue: "overdue",
  idle: "not started",
};

export function deriveCell(f: CellFacts): CellView {
  let value: string;
  if (!f.hasPlans) value = "–";
  else if (f.status === "complete") value = f.doneAt ? fmtDay(f.doneAt) : "Done";
  else if (f.status === "hold") value = "H";
  else if (f.status === "submitted") value = "QC";
  else if (f.status === "overdue") value = f.daysLate != null && f.daysLate >= 1 ? `+${f.daysLate}d` : "late";
  else if (f.status === "progress") value = f.itemsTotal > 0 ? `${f.itemsDone}/${f.itemsTotal}` : "In prog.";
  else value = f.plannedAt ? fmtDay(f.plannedAt) : "not sch.";

  const parts = [f.hasPlans ? STATUS_WORD[f.status] : "no process on this unit", value !== "–" ? value : null];
  if (f.rejected) parts.push("rejected, NCR");
  if (f.outOfSequence) parts.push("out of sequence");
  return {
    status: f.hasPlans ? f.status : "idle",
    hasPlans: f.hasPlans,
    value,
    rejected: f.rejected,
    outOfSequence: f.outOfSequence,
    label: parts.filter(Boolean).join(", "),
  };
}

// ── filters ──────────────────────────────────────────────────────────────

export const BOARD_STATUSES = ["complete", "progress", "submitted", "hold", "overdue", "idle"] as const;

export interface BoardFilter {
  dept: number | null;
  status: BoardStatus | null;
  oos: boolean;
  hideDone: boolean;
}

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseBoardFilter(sp: Params): BoardFilter {
  const dept = Number(first(sp.dept));
  const status = first(sp.status);
  return {
    dept: Number.isInteger(dept) && dept > 0 ? dept : null,
    status: (BOARD_STATUSES as readonly string[]).includes(status ?? "") ? (status as BoardStatus) : null,
    oos: first(sp.oos) === "1",
    hideDone: first(sp.hide) === "1",
  };
}

export function boardFilterQuery(f: BoardFilter): string {
  const q = new URLSearchParams();
  if (f.dept != null) q.set("dept", String(f.dept));
  if (f.status) q.set("status", f.status);
  if (f.oos) q.set("oos", "1");
  if (f.hideDone) q.set("hide", "1");
  const s = q.toString();
  return s ? `?${s}` : "";
}

export interface BoardShape {
  stages: Array<{ stageNo: number; departmentId: number | null }>;
  units: Array<{ unitId: number; cells: Record<number, { status: BoardStatus; outOfSequence: boolean; hasPlans: boolean }> }>;
}

/**
 * Department and "hide finished" cut columns; status and out-of-sequence cut
 * rows to the units that have at least one matching cell in a visible column.
 */
export function applyBoardFilter(shape: BoardShape, f: BoardFilter): { stageNos: number[]; unitIds: number[] } {
  let stages = shape.stages;
  if (f.dept != null) stages = stages.filter((s) => s.departmentId === f.dept);
  if (f.hideDone) {
    stages = stages.filter((s) =>
      shape.units.some((u) => {
        const c = u.cells[s.stageNo];
        return c && c.hasPlans && c.status !== "complete";
      }),
    );
  }
  const stageNos = stages.map((s) => s.stageNo);
  let units = shape.units;
  if (f.status) units = units.filter((u) => stageNos.some((n) => u.cells[n]?.hasPlans && u.cells[n].status === f.status));
  if (f.oos) units = units.filter((u) => stageNos.some((n) => u.cells[n]?.outOfSequence));
  return { stageNos, unitIds: units.map((u) => u.unitId) };
}

// ── Excel: "Units x Process Tracker" (docs/DESPL-320 Production Tracker.xlsx) ──

/** The workbook's own status vocabulary (its dropdown): - Started Submitted Verified Complete Hold. */
export function planStatusWord(status: string, verified: boolean): string {
  switch (status) {
    case "IN_PROGRESS":
      return "Started";
    case "SUBMITTED":
      return "Submitted";
    case "ON_HOLD":
      return "Hold";
    case "COMPLETE":
      return verified ? "Verified" : "Complete";
    default:
      return "-";
  }
}

/** "20-Nov-2026" in IST, as the workbook prints dates. */
export function fmtLongDay(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
