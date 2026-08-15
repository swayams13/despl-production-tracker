import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";

/**
 * Job list with header stats — backs `GET /api/jobs`. Plan tallies come from
 * each job's current schedule run in one grouped aggregate (no N+1); %complete
 * and overdue are computed at the 36-process plan grain per DESIGN_SPEC §11.4
 * (never by averaging the 25-stage rollup). Client scope is enforced by tenant
 * RLS plus the actor's own client filter for portal/viewer users.
 */
export interface JobListItem {
  id: number;
  jobNumber: string;
  projectName: string | null;
  status: string;
  deliveryDate: string | null;
  equipmentCount: number;
  unitCount: number;
  totalPlans: number;
  completePlans: number;
  overduePlans: number;
  percentComplete: number;
}

interface TallyRow {
  job_id: number;
  total: number;
  complete: number;
  overdue: number;
}

export async function loadJobs(actor: Actor): Promise<JobListItem[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const jobs = await tx.job.findMany({
      // Client-scoped users see only their own client's jobs; staff see all.
      where: actor.clientId != null ? { clientId: actor.clientId } : undefined,
      select: {
        id: true,
        jobNumber: true,
        projectName: true,
        status: true,
        deliveryDate: true,
        equipments: { select: { _count: { select: { units: true } } } },
      },
      orderBy: { jobNumber: "asc" },
    });
    if (jobs.length === 0) return [];

    const tallies = await tx.$queryRaw<TallyRow[]>`
      SELECT sr.job_id,
             count(*)::int AS total,
             count(*) FILTER (WHERE pp.status = 'COMPLETE')::int AS complete,
             count(*) FILTER (
               WHERE pp.status <> 'COMPLETE'
                 AND pp.planned_finish IS NOT NULL
                 AND pp.planned_finish < (now() AT TIME ZONE 'UTC')
             )::int AS overdue
      FROM process_plans pp
      JOIN schedule_runs sr ON sr.id = pp.schedule_run_id AND sr.is_current = true
      GROUP BY sr.job_id
    `;
    const tallyByJob = new Map(tallies.map((t) => [t.job_id, t]));

    return jobs.map((j) => {
      const t = tallyByJob.get(j.id);
      const total = t?.total ?? 0;
      const complete = t?.complete ?? 0;
      return {
        id: j.id,
        jobNumber: j.jobNumber,
        projectName: j.projectName,
        status: j.status,
        deliveryDate: j.deliveryDate ? j.deliveryDate.toISOString() : null,
        equipmentCount: j.equipments.length,
        unitCount: j.equipments.reduce((n, e) => n + e._count.units, 0),
        totalPlans: total,
        completePlans: complete,
        overduePlans: t?.overdue ?? 0,
        percentComplete: total > 0 ? Math.round((complete / total) * 100) : 0,
      };
    });
  });
}
