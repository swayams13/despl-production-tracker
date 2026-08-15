import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { ProcessPlanStatus, ProcessEdgeType } from "@/generated/prisma/client";

/**
 * Pure Gantt types + layout math — deliberately split out of `gantt.read.ts`
 * (which imports `@/lib/db`/`@/lib/authz`, both server-only: they pull in
 * `next/headers` via the session/cookie path). `<JobGantt>` is a client
 * component and needs this math directly; importing it from the server-only
 * read module broke the client bundle (turbopack: "the chunking context does
 * not support external modules"). No DB/auth imports belong in this file.
 */
export interface GanttBar {
  jobProcessId: number;
  code: string;
  name: string;
  seq: number;
  /** First stage this process rolls into (§11.1) — routes row-click to StageSheet. */
  stageNo: number;
  deptName: string;
  status: ProcessPlanStatus;
  overdue: boolean;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  standardDays: number | null;
}

export interface GanttEdge {
  processId: number;
  predecessorId: number;
  type: ProcessEdgeType;
}

export interface GanttUnit {
  unitId: number;
  serialNo: string;
  bars: GanttBar[];
}

export interface JobGanttData {
  units: GanttUnit[];
  edges: GanttEdge[];
  now: string;
}

/** Row-level §11.2 fill status for a single ProcessPlan (not a stage rollup). */
export function planFillStatus(status: ProcessPlanStatus, overdue: boolean): StageDisplayStatus {
  if (status === "COMPLETE") return "complete"; // checked first, mirrors §11.2's stage-level ladder
  if (status === "ON_HOLD") return "hold";
  if (overdue) return "overdue";
  if (status === "SUBMITTED") return "submitted";
  if (status === "IN_PROGRESS") return "progress";
  return "idle";
}

export interface GanttDomain {
  start: number;
  end: number;
}

/**
 * The visible date window for one unit's bar group: earliest planned/actual
 * start to latest planned/actual finish, padded to include "now" (so an
 * in-progress bar with no actualFinish yet, and the today marker, both stay
 * on-screen). Falls back to a 1-day window around `now` when the unit has no
 * dated bars at all (caller should render an empty state instead in that case).
 */
export function computeGanttDomain(bars: GanttBar[], nowIso: string): GanttDomain {
  const now = new Date(nowIso).getTime();
  const dates: number[] = [now];
  for (const b of bars) {
    for (const d of [b.plannedStart, b.plannedFinish, b.actualStart, b.actualFinish]) {
      if (d) dates.push(new Date(d).getTime());
    }
  }
  const start = Math.min(...dates);
  const end = Math.max(...dates);
  return start === end ? { start, end: start + 86400000 } : { start, end };
}

/** Position of an ISO date as a 0–100 percentage across the domain, or null if unset. */
export function ganttPct(iso: string | null, domain: GanttDomain): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return ((t - domain.start) / (domain.end - domain.start)) * 100;
}
