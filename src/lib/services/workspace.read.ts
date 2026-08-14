import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { computeCpm } from "@/lib/schedule";
import { loadJobSpine, getCurrentScheduleRun } from "./_shared";
import { prioritize, type RankedPlan } from "./prioritizer";
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
