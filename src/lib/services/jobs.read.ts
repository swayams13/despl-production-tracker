import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { loadUnitSpinesBatch, rollupJobSpine } from "./spine.read";
import { loadOpenHoldPointsBatch } from "./workspace.read";
import type { StageSegment } from "@/components/industrial/stage-status";

/**
 * Job list with header stats — backs `GET /api/jobs` and `/jobs` (§4.3). Plan
 * tallies + forecast + last-activity come from each job's current schedule
 * run / event stream in grouped aggregates (no N+1); %complete is the
 * duration-weighted, mapped-ops-aware figure from `v_process_plan_percent`
 * (Phase 3, R1/R3) — every percent-complete surface reads that same view, so
 * they can no longer disagree (never re-derive from `totalPlans`/
 * `completePlans`, which stay as raw counts only). Client scope is enforced
 * by tenant RLS plus the actor's own client filter for portal/viewer users.
 */
export interface JobListItem {
  id: number;
  jobNumber: string;
  projectName: string | null;
  familyName: string;
  status: string;
  committedDeliveryDate: string | null;
  forecastDispatch: string | null;
  forecastVarianceDays: number | null;
  equipmentCount: number;
  unitCount: number;
  totalPlans: number;
  completePlans: number;
  overduePlans: number;
  percentComplete: number;
  openHoldPoints: number;
  lastActivityAt: string | null;
  /** Job-level (cross-unit) mini-spine, empty when no schedule has been generated yet. */
  unitRollup: StageSegment[];
}

interface TallyRow {
  job_id: number;
  total: number;
  complete: number;
  overdue: number;
  forecast: Date | null;
}

interface ActivityRow {
  job_id: number;
  last_at: Date;
}

interface PercentRow {
  job_id: number;
  /** numeric from Postgres SUM()/division comes back as a string via pg's driver. */
  percent: string | number;
}

export async function loadJobs(actor: Actor): Promise<JobListItem[]> {
  const base = await withTenant(actor.tenantId, async (tx) => {
    const jobs = await tx.job.findMany({
      // Client-scoped users see only their own client's jobs; staff see all.
      where: actor.clientId != null ? { clientId: actor.clientId } : undefined,
      select: {
        id: true,
        jobNumber: true,
        projectName: true,
        status: true,
        committedDeliveryDate: true,
        family: { select: { name: true } },
        equipments: { select: { _count: { select: { units: true } } } },
      },
      orderBy: { jobNumber: "asc" },
    });
    if (jobs.length === 0) return [];

    const jobIds = jobs.map((j) => j.id);
    const tallies = await tx.$queryRaw<TallyRow[]>`
      SELECT sr.job_id,
             count(*)::int AS total,
             count(*) FILTER (WHERE pp.status = 'COMPLETE')::int AS complete,
             count(*) FILTER (
               WHERE pp.status <> 'COMPLETE'
                 AND pp.planned_finish IS NOT NULL
                 AND pp.planned_finish < (now() AT TIME ZONE 'UTC')
             )::int AS overdue,
             max(pp.planned_finish) AS forecast
      FROM process_plans pp
      JOIN schedule_runs sr ON sr.id = pp.schedule_run_id AND sr.is_current = true
      WHERE sr.job_id = ANY(${jobIds}::int[])
      GROUP BY sr.job_id
    `;
    const tallyByJob = new Map(tallies.map((t) => [t.job_id, t]));

    // Phase 3, R1/R3: percentComplete is duration-weighted, mapped-ops-aware
    // completion from the single view every percent-complete surface reads —
    // never the plain complete/total ratio above (kept only for the raw counts).
    const percents = await tx.$queryRaw<PercentRow[]>`
      SELECT job_id, sum(percent * weight) / sum(weight) AS percent
      FROM v_process_plan_percent
      WHERE job_id = ANY(${jobIds}::int[])
      GROUP BY job_id
    `;
    const percentByJob = new Map(percents.map((p) => [p.job_id, p.percent]));

    const activity = await tx.$queryRaw<ActivityRow[]>`
      SELECT jp.job_id, max(de.at) AS last_at
      FROM domain_events de
      JOIN process_plans pp ON pp.id = de.aggregate_id::int
      JOIN job_processes jp ON jp.id = pp.job_process_id
      WHERE de.aggregate_type = 'ProcessPlan' AND jp.job_id = ANY(${jobIds}::int[])
      GROUP BY jp.job_id

      UNION ALL

      SELECT jp.job_id, max(de.at) AS last_at
      FROM domain_events de
      JOIN delay_reasons dr ON dr.id = de.aggregate_id::int
      JOIN process_plans pp ON pp.id = dr.process_plan_id
      JOIN job_processes jp ON jp.id = pp.job_process_id
      WHERE de.aggregate_type = 'DelayReason' AND jp.job_id = ANY(${jobIds}::int[])
      GROUP BY jp.job_id
    `;
    // Two rows per job possible (one per UNION branch) — keep the later timestamp.
    const activityByJob = new Map<number, Date>();
    for (const a of activity) {
      const prev = activityByJob.get(a.job_id);
      if (!prev || a.last_at > prev) activityByJob.set(a.job_id, a.last_at);
    }

    return jobs.map((j) => {
      const t = tallyByJob.get(j.id);
      const total = t?.total ?? 0;
      const complete = t?.complete ?? 0;
      const forecastDispatch = t?.forecast ?? null;
      return {
        id: j.id,
        jobNumber: j.jobNumber,
        projectName: j.projectName,
        familyName: j.family.name,
        status: j.status,
        committedDeliveryDate: j.committedDeliveryDate,
        forecastDispatch,
        forecastVarianceDays:
          forecastDispatch && j.committedDeliveryDate ? Math.round((forecastDispatch.getTime() - j.committedDeliveryDate.getTime()) / 864e5) : null,
        equipmentCount: j.equipments.length,
        unitCount: j.equipments.reduce((n, e) => n + e._count.units, 0),
        totalPlans: total,
        completePlans: complete,
        overduePlans: t?.overdue ?? 0,
        percentComplete: Math.round(Number(percentByJob.get(j.id) ?? 0)),
        lastActivityAt: activityByJob.get(j.id) ?? null,
      };
    });
  });
  if (base.length === 0) return [];

  // Per-job extras (hold points, spine rollup), batched into 2 grouped
  // queries total instead of 2 per job — Gate 4 N+1 fix.
  const jobIds = base.map((j) => j.id);
  const [holdPointsByJob, unitSpinesByJob] = await Promise.all([
    loadOpenHoldPointsBatch(actor, jobIds),
    loadUnitSpinesBatch(actor, jobIds),
  ]);
  const extrasByJob = new Map(
    base.map((j) => [
      j.id,
      {
        openHoldPoints: (holdPointsByJob.get(j.id) ?? []).length,
        unitRollup: rollupJobSpine(unitSpinesByJob.get(j.id) ?? []),
      },
    ]),
  );

  return base.map((j) => {
    const extra = extrasByJob.get(j.id)!;
    return {
      ...j,
      committedDeliveryDate: j.committedDeliveryDate ? j.committedDeliveryDate.toISOString() : null,
      forecastDispatch: j.forecastDispatch ? j.forecastDispatch.toISOString() : null,
      lastActivityAt: j.lastActivityAt ? j.lastActivityAt.toISOString() : null,
      openHoldPoints: extra.openHoldPoints,
      unitRollup: extra.unitRollup,
    };
  });
}
