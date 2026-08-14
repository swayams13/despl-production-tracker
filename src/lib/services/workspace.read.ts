import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { computeCpm } from "@/lib/schedule";
import { loadJobSpine, getCurrentScheduleRun } from "./_shared";
import { prioritize, type RankedPlan } from "./prioritizer";
import type { Department } from "@/generated/prisma/client";

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
    return { runId: run.id, rankedByDept, departments, processNameById };
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
