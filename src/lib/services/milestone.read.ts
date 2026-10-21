import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { rollupMilestones, type JobMilestones, type MilestoneMapEntry } from "@/lib/shared/milestones";

/**
 * Lean Core J8 (D9): where each job stands against the company-wide milestones.
 * Progress is weighted by planned effort (`lib/shared/milestones.ts`); a weighting
 * between milestones, not a schedule, so invariant 10 holds.
 *
 * Tenant scoping: `process_plans` has no RLS of its own, so the query filters on
 * the job ids explicitly (and on the tenant), never on `withTenant` alone.
 * `loadMilestonesBatch` trusts its job ids (callers pass ids they already read
 * through a client-scoped reader); `loadJobMilestones` checks the client scope.
 */

const EMPTY: JobMilestones = { milestones: [], current: null, noStageList: false, unmappedPlans: 0 };

export async function loadMilestonesBatch(actor: Actor, jobIds: number[]): Promise<Map<number, JobMilestones>> {
  const out = new Map<number, JobMilestones>();
  if (jobIds.length === 0) return out;
  const now = new Date();

  return withTenant(actor.tenantId, async (tx) => {
    const jobs = await tx.job.findMany({ where: { id: { in: jobIds }, tenantId: actor.tenantId }, select: { id: true, familyId: true } });
    const familyIds = [...new Set(jobs.map((j) => j.familyId))];
    const [defs, maps, stageCounts, plans] = await Promise.all([
      tx.milestone.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, code: true, name: true, sortOrder: true } }),
      tx.milestoneProcessMap.findMany({
        where: { tenantId: actor.tenantId, familyId: { in: familyIds } },
        select: { familyId: true, processCode: true, milestoneId: true, weight: true },
      }),
      tx.workOrderStage.groupBy({ by: ["familyId"], where: { tenantId: actor.tenantId, familyId: { in: familyIds } }, _count: { _all: true } }),
      tx.processPlan.findMany({
        where: { jobId: { in: jobs.map((j) => j.id) }, tenantId: actor.tenantId, scheduleRun: { isCurrent: true }, jobProcess: { included: true } },
        select: { jobId: true, status: true, plannedFinish: true, jobProcess: { select: { code: true, durationMaxDays: true } } },
      }),
    ]);

    const mapByFamily = new Map<number, Map<string, MilestoneMapEntry>>();
    for (const m of maps) {
      const f = mapByFamily.get(m.familyId) ?? new Map<string, MilestoneMapEntry>();
      f.set(m.processCode, { milestoneId: m.milestoneId, weight: m.weight == null ? null : Number(m.weight) });
      mapByFamily.set(m.familyId, f);
    }
    const hasStages = new Set(stageCounts.filter((c) => c._count._all > 0).map((c) => c.familyId));
    const plansByJob = new Map<number, typeof plans>();
    for (const p of plans) plansByJob.set(p.jobId, [...(plansByJob.get(p.jobId) ?? []), p]);

    for (const j of jobs) {
      const map = mapByFamily.get(j.familyId);
      const noStageList = !hasStages.has(j.familyId);
      if (!map) {
        out.set(j.id, { ...EMPTY, noStageList });
        continue;
      }
      const facts = (plansByJob.get(j.id) ?? []).map((p) => ({
        processCode: p.jobProcess.code,
        durationDays: p.jobProcess.durationMaxDays,
        status: p.status,
        plannedFinish: p.plannedFinish,
      }));
      out.set(j.id, { ...rollupMilestones(defs, map, facts, now), noStageList });
    }
    return out;
  });
}

/** One job's milestones; null when the job is not visible to the actor. */
export async function loadJobMilestones(actor: Actor, jobId: number): Promise<JobMilestones | null> {
  const job = await withTenant(actor.tenantId, (tx) => tx.job.findUnique({ where: { id: jobId }, select: { clientId: true, tenantId: true } }));
  if (!job || job.tenantId !== actor.tenantId) return null;
  assertClientScope(actor, job.clientId);
  return (await loadMilestonesBatch(actor, [jobId])).get(jobId) ?? null;
}
