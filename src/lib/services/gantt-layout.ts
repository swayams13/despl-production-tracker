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
 * start to latest planned/actual finish. `now` extends the *end* only (so an
 * in-progress bar with no actualFinish yet, and the today marker, stay
 * on-screen for a job that's overdue or running past its last dated bar) —
 * it never pulls `start` earlier. A job whose schedule hasn't started yet
 * (e.g. a real order date months in the future) would otherwise get a huge
 * dead zone from today to the real start, compressing the whole schedule
 * into a sliver. Falls back to a 1-day window around `now` when the unit has
 * no dated bars at all (caller should render an empty state instead in that case).
 */
export function computeGanttDomain(bars: GanttBar[], nowIso: string): GanttDomain {
  const now = new Date(nowIso).getTime();
  const dates: number[] = [];
  for (const b of bars) {
    for (const d of [b.plannedStart, b.plannedFinish, b.actualStart, b.actualFinish]) {
      if (d) dates.push(new Date(d).getTime());
    }
  }
  if (dates.length === 0) return { start: now, end: now + 86400000 };
  const start = Math.min(...dates);
  const end = Math.max(now, ...dates);
  return start === end ? { start, end: start + 86400000 } : { start, end };
}

export interface DepartmentDeadline {
  deptName: string;
  /** Earliest `plannedStart` across every unit's bars owned by this department. */
  firstStartsBy: string | null;
  /** Latest `plannedFinish` across every unit's bars owned by this department. */
  ownWorkDoneBy: string | null;
  /** Distinct processes (by code) this department owns — not a per-unit row count. */
  processCount: number;
}

/**
 * Job-level "Department Deadlines" rollup (mirrors the reference workbook's
 * own sheet of the same name): one row per department, spanning every unit
 * already loaded in `JobGanttData.units` — no separate DB round trip. Units
 * currently share identical dates per process (the pilot schedules the whole
 * job at once, §0 in BUILD-SPEC-v2), but this takes the union across units
 * regardless, so a future per-unit stagger is handled without a call-site change.
 */
export function computeDepartmentDeadlines(units: GanttUnit[]): DepartmentDeadline[] {
  const byDept = new Map<string, { start: number | null; finish: number | null; codes: Set<string> }>();
  for (const u of units) {
    for (const b of u.bars) {
      const entry = byDept.get(b.deptName) ?? { start: null, finish: null, codes: new Set<string>() };
      if (b.plannedStart) {
        const t = new Date(b.plannedStart).getTime();
        if (entry.start == null || t < entry.start) entry.start = t;
      }
      if (b.plannedFinish) {
        const t = new Date(b.plannedFinish).getTime();
        if (entry.finish == null || t > entry.finish) entry.finish = t;
      }
      entry.codes.add(b.code);
      byDept.set(b.deptName, entry);
    }
  }
  return [...byDept.entries()]
    .map(([deptName, e]) => ({
      deptName,
      firstStartsBy: e.start != null ? new Date(e.start).toISOString() : null,
      ownWorkDoneBy: e.finish != null ? new Date(e.finish).toISOString() : null,
      processCount: e.codes.size,
    }))
    .sort((a, b) => (a.firstStartsBy ?? "").localeCompare(b.firstStartsBy ?? ""));
}

/** Position of an ISO date as a 0–100 percentage across the domain, or null if unset. */
export function ganttPct(iso: string | null, domain: GanttDomain): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return ((t - domain.start) / (domain.end - domain.start)) * 100;
}
