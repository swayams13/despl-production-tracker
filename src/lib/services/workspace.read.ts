import { withTenant } from "@/lib/db";
import { assertClientScope, hasRole, ROLES, type Actor } from "@/lib/authz";
import { computeCpm } from "@/lib/schedule";
import { loadJobSpine, getCurrentScheduleRun } from "./_shared";
import { prioritize, type PlanState, type RankedPlan } from "./prioritizer";
import type { Department, DelayCategoryRef, ProcessPlan } from "@/generated/prisma/client";

/**
 * The current run's per-department prioritized view — the shared read behind
 * the workspace page (Task 10) and later QC/delay/dashboard tasks. Computes
 * CPM float once from the job spine, then hands ProcessPlan rows + float +
 * process names to the pure `prioritize` ranker.
 */
export interface PrioritizedJob {
  runId: number;
  rankedByDept: Map<number, RankedPlan[]>;
  departments: Department[];
  processNameById: Map<number, string>;
  delayCategories: DelayCategoryRef[];
}

export async function loadPrioritizedJob(actor: Actor, jobId: number): Promise<PrioritizedJob | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    // Job-grain key: per-unit plans live under the null-equipment run.
    const run = await getCurrentScheduleRun(tx, jobId, null);
    if (!run) return null;

    const spine = await loadJobSpine(tx, jobId);
    const cpm = computeCpm(spine.processes, spine.edges);
    const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
    const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));

    const rankedByDept = prioritize({
      plans: run.processPlans,
      edges: spine.edges,
      floatByProcessId,
      processNameById,
      today: new Date(),
    });

    const departments = await tx.department.findMany();
    const delayCategories = await tx.delayCategoryRef.findMany({ where: { active: true } });
    return { runId: run.id, rankedByDept, departments, processNameById, delayCategories };
  });
}

export interface OpenHoldPoint {
  qcpItemId: number;
  activity: string;
  unitId: number;
  serialNo: string;
}

/**
 * Open blocking hold points across the job's units — the same
 * blocking/latest-attempt logic as `assertNoOpenHoldPoint` in `_shared.ts`,
 * but fanned out over every (blocking QcpItem × job unit) pair instead of a
 * single process/unit, so the QC "clear a hold point" list agrees with what
 * the gate will actually refuse.
 */
export async function loadOpenHoldPoints(actor: Actor, jobId: number): Promise<OpenHoldPoint[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return [];
    assertClientScope(actor, job.clientId);

    const units = await tx.unit.findMany({
      where: { equipment: { jobId } },
      select: { id: true, serialNo: true },
    });
    if (units.length === 0) return [];

    const blockingItems = await tx.qcpItem.findMany({
      where: {
        processLinks: { some: { jobProcess: { jobId } } },
        partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
      },
      select: { id: true, activity: true },
    });
    if (blockingItems.length === 0) return [];

    const itemIds = blockingItems.map((i) => i.id);
    const unitIds = units.map((u) => u.id);
    const execs = await tx.qcpExecution.findMany({
      where: { unitId: { in: unitIds }, qcpItemId: { in: itemIds } },
      orderBy: { attemptNo: "desc" },
      select: { qcpItemId: true, unitId: true, result: true },
    });

    // Latest attempt per (item, unit) — mirrors assertNoOpenHoldPoint's per-item map.
    const latestByKey = new Map<string, string>();
    for (const e of execs) {
      const k = `${e.qcpItemId}:${e.unitId}`;
      if (!latestByKey.has(k)) latestByKey.set(k, e.result);
    }

    const activityByItem = new Map(blockingItems.map((i) => [i.id, i.activity]));
    const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));

    const open: OpenHoldPoint[] = [];
    for (const itemId of itemIds) {
      for (const unitId of unitIds) {
        const r = latestByKey.get(`${itemId}:${unitId}`);
        if (r !== "ACCEPTED" && r !== "NA") { // undefined (no exec), PENDING, REJECTED all block
          open.push({ qcpItemId: itemId, activity: activityByItem.get(itemId)!, unitId, serialNo: serialByUnit.get(unitId)! });
        }
      }
    }
    return open;
  });
}

// ── Workspace view (§4.4) — per-process cards + QC queue ─────────────────

export interface WsUnitRow {
  planId: number;
  serialNo: string;
  plannedFinish: string | null;
  daysOverdue: number;
  overdue: boolean;
  state: PlanState;
  reasonText: string;
  criticalPath: boolean;
}
export interface WsCard {
  jobProcessId: number;
  processName: string;
  stageLabel: string;
  deptName: string;
  overdueCount: number;
  criticalPath: boolean;
  units: WsUnitRow[];
}
export interface WsQcRow {
  planId: number;
  processName: string;
  serialNo: string;
  submittedBy: string | null;
}
export interface WorkspaceView {
  jobId: number;
  jobNumber: string;
  isQc: boolean;
  counts: { overdue: number; dueToday: number; awaitingQc: number };
  cards: WsCard[];
  qcQueue: WsQcRow[];
  holdPoints: OpenHoldPoint[];
  delayCategories: { id: number; name: string }[];
  filter: { label: string } | null;
}

export interface WorkspaceFilter {
  dept?: string; // department id or name (dashboard matrix deep-link)
  status?: string; // a display state: overdue | hold | submitted | progress | ready | idle
  sort?: string; // critical (default) | overdue | due
}

const STAGE_COUNT = 25;

function stageLabel(workOrderStages: number[]): string {
  if (workOrderStages.length === 0) return "—";
  const lo = Math.min(...workOrderStages);
  const hi = Math.max(...workOrderStages);
  return lo === hi ? `Stage ${lo} of ${STAGE_COUNT}` : `Stages ${lo}–${hi} of ${STAGE_COUNT}`;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

/** Map a RankedPlan to the display state used by the row action button. */
function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 864e5));
}

/**
 * The `/workspace` view model (§4.4): the actor's scoped plans grouped into
 * per-process cards (rows = units), a QC verification queue (SUBMITTED, all
 * departments — QC verifies cross-dept), open hold points, and the header
 * counts. Reuses the same spine/CPM/prioritize pipeline as `loadPrioritizedJob`
 * / `loadJobKpis`. Filters (dashboard deep-links) narrow the plans before
 * grouping; the returned `filter.label` drives the dismissible chip.
 */
export async function loadWorkspaceView(
  actor: Actor,
  jobId: number,
  filter: WorkspaceFilter = {},
): Promise<WorkspaceView | null> {
  const holdPoints = hasRole(actor, ROLES.QC) ? await loadOpenHoldPoints(actor, jobId) : [];

  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true, jobNumber: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const run = await getCurrentScheduleRun(tx, jobId, null);
    if (!run) return null;

    const spine = await loadJobSpine(tx, jobId);
    const cpm = computeCpm(spine.processes, spine.edges);
    const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
    const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));
    const procMeta = new Map(
      spine.rawProcesses.map((p) => [p.id, { name: p.name, stageLabel: stageLabel(p.workOrderStages), deptId: p.departmentId }]),
    );

    const rankedByDept = prioritize({
      plans: run.processPlans,
      edges: spine.edges,
      floatByProcessId,
      processNameById,
      today: new Date(),
    });

    const departments = await tx.department.findMany();
    const deptNameById = new Map(departments.map((d) => [d.id, d.name]));

    const seesAll = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.MANAGEMENT);
    const scopedDeptIds = seesAll ? new Set(departments.map((d) => d.id)) : new Set(actor.departmentIds);

    const units = await tx.unit.findMany({ where: { equipment: { jobId } }, select: { id: true, serialNo: true } });
    const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));

    const today = new Date();

    // Filter predicate over a ranked plan (dashboard deep-link narrowing).
    const deptFilterId = resolveDeptFilter(filter.dept, deptNameById);
    const statusFilter = filter.status?.toLowerCase();
    const matchesFilter = (r: RankedPlan, deptId: number): boolean => {
      if (deptFilterId != null && deptId !== deptFilterId) return false;
      if (statusFilter) return displayState(r) === statusFilter;
      return true;
    };

    // Header counts over the actor's whole scope (unfiltered).
    let overdue = 0;
    let dueToday = 0;
    let awaitingQc = 0;
    const scopedRanked: RankedPlan[] = [];
    for (const [deptId, rows] of rankedByDept) {
      if (!scopedDeptIds.has(deptId)) continue;
      for (const r of rows) {
        scopedRanked.push(r);
        if (r.overdue) overdue++;
        else if (r.plan.plannedFinish && r.state !== "DONE" && sameCalendarDay(r.plan.plannedFinish, today)) dueToday++;
        if (r.state === "SUBMITTED") awaitingQc++;
      }
    }

    // Per-process cards: scoped, actionable (not DONE, not SUBMITTED), filtered.
    const cardByProcess = new Map<number, WsCard>();
    for (const r of scopedRanked) {
      if (r.state === "DONE" || r.state === "SUBMITTED") continue;
      const meta = procMeta.get(r.plan.jobProcessId);
      if (!meta) continue;
      if (!matchesFilter(r, meta.deptId)) continue;

      let card = cardByProcess.get(r.plan.jobProcessId);
      if (!card) {
        card = {
          jobProcessId: r.plan.jobProcessId,
          processName: meta.name,
          stageLabel: meta.stageLabel,
          deptName: deptNameById.get(meta.deptId) ?? `#${meta.deptId}`,
          overdueCount: 0,
          criticalPath: false,
          units: [],
        };
        cardByProcess.set(r.plan.jobProcessId, card);
      }
      const daysOverdue = r.overdue && r.plan.plannedFinish ? daysBetween(r.plan.plannedFinish, today) : 0;
      card.units.push({
        planId: r.plan.id,
        serialNo: r.plan.unitId != null ? serialByUnit.get(r.plan.unitId) ?? `#${r.plan.unitId}` : "—",
        plannedFinish: r.plan.plannedFinish ? r.plan.plannedFinish.toISOString() : null,
        daysOverdue,
        overdue: r.overdue,
        state: r.state,
        reasonText: r.reasonText,
        criticalPath: r.criticalPath,
      });
      if (r.overdue) card.overdueCount++;
      if (r.criticalPath) card.criticalPath = true;
    }
    // Units within a card by serial; cards by the chosen sort (§4.4).
    const cards = Array.from(cardByProcess.values());
    for (const c of cards) c.units.sort((a, b) => a.serialNo.localeCompare(b.serialNo));
    sortCards(cards, filter.sort);

    // QC queue: SUBMITTED plans across ALL departments (QC verifies cross-dept).
    const isQc = hasRole(actor, ROLES.QC);
    const qcQueue: WsQcRow[] = [];
    if (isQc) {
      const submitted = Array.from(rankedByDept.values()).flat().filter((r) => r.state === "SUBMITTED");
      const submitterIds = [...new Set(submitted.map((r) => r.plan.submittedBy).filter((x): x is number => x != null))];
      const submitters = submitterIds.length
        ? await tx.user.findMany({ where: { id: { in: submitterIds } }, select: { id: true, name: true } })
        : [];
      const nameById = new Map(submitters.map((u) => [u.id, u.name]));
      for (const r of submitted) {
        qcQueue.push({
          planId: r.plan.id,
          processName: processNameById.get(r.plan.jobProcessId) ?? `#${r.plan.jobProcessId}`,
          serialNo: r.plan.unitId != null ? serialByUnit.get(r.plan.unitId) ?? `#${r.plan.unitId}` : "—",
          submittedBy: r.plan.submittedBy != null ? nameById.get(r.plan.submittedBy) ?? null : null,
        });
      }
    }

    const delayCategories = (await tx.delayCategoryRef.findMany({ where: { active: true }, select: { id: true, name: true } }));

    const filterLabel = buildFilterLabel(deptFilterId, deptNameById, statusFilter);

    return {
      jobId,
      jobNumber: job.jobNumber,
      isQc,
      counts: { overdue, dueToday, awaitingQc },
      cards,
      qcQueue,
      holdPoints,
      delayCategories,
      filter: filterLabel ? { label: filterLabel } : null,
    };
  });
}

/** Order the worklist cards by the chosen sort. Default: overdue-then-critical. */
function sortCards(cards: WsCard[], sort?: string): void {
  if (sort === "overdue") {
    const maxOverdue = (c: WsCard) => Math.max(0, ...c.units.map((u) => u.daysOverdue));
    cards.sort((a, b) => maxOverdue(b) - maxOverdue(a) || a.processName.localeCompare(b.processName));
    return;
  }
  if (sort === "due") {
    const earliest = (c: WsCard) => Math.min(...c.units.map((u) => (u.plannedFinish ? new Date(u.plannedFinish).getTime() : Infinity)));
    cards.sort((a, b) => earliest(a) - earliest(b) || a.processName.localeCompare(b.processName));
    return;
  }
  // critical (default): has-overdue first, then critical path, then name.
  cards.sort(
    (a, b) =>
      Number(b.overdueCount > 0) - Number(a.overdueCount > 0) ||
      Number(b.criticalPath) - Number(a.criticalPath) ||
      a.processName.localeCompare(b.processName),
  );
}

/** The §11.2-style display state of a ranked plan, for status filtering. */
function displayState(r: RankedPlan): string {
  if (r.state === "DONE") return "complete";
  if (r.state === "ON_HOLD") return "hold";
  if (r.overdue) return "overdue";
  if (r.state === "SUBMITTED") return "submitted";
  if (r.state === "IN_PROGRESS" || r.state === "READY") return "progress";
  return "idle";
}

function resolveDeptFilter(dept: string | undefined, deptNameById: Map<number, string>): number | null {
  if (!dept) return null;
  if (/^\d+$/.test(dept)) return Number(dept);
  const hit = [...deptNameById].find(([, name]) => name.toLowerCase() === dept.toLowerCase());
  return hit ? hit[0] : null;
}

function buildFilterLabel(deptId: number | null, deptNameById: Map<number, string>, status?: string): string | null {
  const parts: string[] = [];
  if (deptId != null) parts.push(deptNameById.get(deptId) ?? `Dept #${deptId}`);
  if (status) parts.push(status[0].toUpperCase() + status.slice(1));
  return parts.length ? parts.join(" · ") : null;
}

// ── Management KPI dashboard (Task 13) ───────────────────────────────────

const PLAN_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "COMPLETE", "ON_HOLD"] as const;

function emptyStatusCounts(): Record<string, number> {
  return Object.fromEntries(PLAN_STATUSES.map((s) => [s, 0]));
}

/** Cumulative planned-vs-actual counts, one point per week from the run's
 * project start to the later of (latest plannedFinish, today). `actual` is
 * null for weeks still in the future — no actual data to report yet. */
function buildSCurve(
  plans: ProcessPlan[],
  projectStartDate: Date,
): { label: string; planned: number; actual: number | null }[] {
  const finishDates = plans.map((p) => p.plannedFinish).filter((d): d is Date => d != null);
  if (finishDates.length === 0) return [];

  const today = new Date();
  const maxFinish = new Date(Math.max(...finishDates.map((d) => d.getTime())));
  const horizonEnd = maxFinish > today ? maxFinish : today;

  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const totalWeeks = Math.max(1, Math.ceil((horizonEnd.getTime() - projectStartDate.getTime()) / msPerWeek));

  const points: { label: string; planned: number; actual: number | null }[] = [];
  for (let w = 1; w <= totalWeeks; w++) {
    const weekEnd = new Date(projectStartDate.getTime() + w * msPerWeek);
    const planned = plans.filter((p) => p.plannedFinish != null && p.plannedFinish <= weekEnd).length;
    const actual =
      weekEnd <= today
        ? plans.filter((p) => p.status === "COMPLETE" && p.actualFinish != null && p.actualFinish <= weekEnd).length
        : null;
    points.push({ label: `W${w}`, planned, actual });
  }
  return points;
}

export interface JobKpis {
  totalPlans: number;
  percentComplete: number;
  byState: Record<string, number>;
  overdue: number;
  openHoldPoints: number;
  delaysByCategory: { category: string; count: number }[];
  deptMatrix: { department: string; counts: Record<string, number> }[];
  sCurve: { label: string; planned: number; actual: number | null }[];
}

/**
 * Cross-department KPI aggregate behind `/dashboard` (Task 13) — MD/CEO/SJ's
 * "leadership sees the workflow working" screen. Reuses the same spine/CPM/
 * prioritize pipeline `loadPrioritizedJob` runs (one tx, no new engine work),
 * then folds the ranked plans + raw ProcessPlan rows + delay reasons into
 * plain, serialisable primitives for the viz components (no Prisma
 * Dates/Maps leaking to the client).
 */
export async function loadJobKpis(actor: Actor, jobId: number): Promise<JobKpis | null> {
  // Its own tx (same as the workspace page's QC section) — the small race
  // window against the transaction below is immaterial for a read-only KPI
  // dashboard.
  const openHoldPoints = await loadOpenHoldPoints(actor, jobId);

  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const run = await getCurrentScheduleRun(tx, jobId, null);
    if (!run) return null;

    const spine = await loadJobSpine(tx, jobId);
    const cpm = computeCpm(spine.processes, spine.edges);
    const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
    const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));

    const rankedByDept = prioritize({
      plans: run.processPlans,
      edges: spine.edges,
      floatByProcessId,
      processNameById,
      today: new Date(),
    });

    const byState: Record<string, number> = {};
    let overdue = 0;
    for (const r of rankedByDept.values()) {
      for (const p of r) {
        byState[p.state] = (byState[p.state] ?? 0) + 1;
        if (p.overdue) overdue++;
      }
    }

    const totalPlans = run.processPlans.length;
    const completeCount = run.processPlans.filter((p) => p.status === "COMPLETE").length;
    const percentComplete = totalPlans > 0 ? Math.round((completeCount / totalPlans) * 100) : 0;

    const departments = await tx.department.findMany();
    const deptNameById = new Map(departments.map((d) => [d.id, d.name]));
    const matrixByDept = new Map<number, Record<string, number>>();
    for (const p of run.processPlans) {
      const counts = matrixByDept.get(p.ownerDepartmentId) ?? emptyStatusCounts();
      counts[p.status] = (counts[p.status] ?? 0) + 1;
      matrixByDept.set(p.ownerDepartmentId, counts);
    }
    const deptMatrix = Array.from(matrixByDept, ([deptId, counts]) => ({
      department: deptNameById.get(deptId) ?? `#${deptId}`,
      counts,
    }));

    const delayRows = await tx.delayReason.findMany({
      where: { processPlan: { scheduleRunId: run.id } },
      select: { category: { select: { name: true } } },
    });
    const delayCountByCategory = new Map<string, number>();
    for (const d of delayRows) {
      delayCountByCategory.set(d.category.name, (delayCountByCategory.get(d.category.name) ?? 0) + 1);
    }
    const delaysByCategory = Array.from(delayCountByCategory, ([category, count]) => ({ category, count }));

    return {
      totalPlans,
      percentComplete,
      byState,
      overdue,
      openHoldPoints: openHoldPoints.length,
      delaysByCategory,
      deptMatrix,
      sCurve: buildSCurve(run.processPlans, run.projectStartDate),
    };
  });
}
