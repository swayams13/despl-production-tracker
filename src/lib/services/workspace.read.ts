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
