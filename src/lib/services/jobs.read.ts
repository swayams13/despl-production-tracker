import { cache } from "react";
import { withTenant, type Tx } from "@/lib/db";
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

/** Pre-serialization row shape (dates still `Date`, not ISO strings) — used only to type the empty-jobs early return so it unifies with `mapped`'s inferred type instead of `JobListItem[]`'s (string dates). */
type JobRow = Omit<JobListItem, "committedDeliveryDate" | "forecastDispatch" | "lastActivityAt" | "openHoldPoints" | "unitRollup"> & {
  committedDeliveryDate: Date | null;
  forecastDispatch: Date | null;
  lastActivityAt: Date | null;
};

/**
 * What the app shell needs of a job (sidebar, switcher, topbar): the cheap half of `JobListItem`.
 * No hold points, no spine, no last-activity, no percent — those cost a `domain_events` join and the whole
 * `v_unit_stage_status` view per job, and the shell renders on every page load (AUD-020).
 */
export type ShellJob = Omit<JobListItem, "openHoldPoints" | "lastActivityAt" | "unitRollup" | "percentComplete">;

/** Most jobs the shell lists. ACTIVE jobs are taken first, so the sidebar's worst-five and the switcher never lose a live job. */
export const SHELL_JOB_CAP = 50;

/**
 * Shell variant of `loadJobs` (AUD-020): same fields and same values as `loadJobs` for the jobs it
 * returns, minus the heavy extras, capped at SHELL_JOB_CAP (ACTIVE first), ordered by job number.
 * Memoised per render on the actor, so the layout and a page share one call.
 */
export const loadShellJobs = cache(async (actor: Actor): Promise<ShellJob[]> => {
  const { base } = await loadJobsBase(actor, undefined, { shell: true });
  return base.map(toShellJob);
});

function toShellJob({ lastActivityAt: _a, percentComplete: _p, ...j }: JobRow): ShellJob {
  return {
    ...j,
    committedDeliveryDate: j.committedDeliveryDate ? j.committedDeliveryDate.toISOString() : null,
    forecastDispatch: j.forecastDispatch ? j.forecastDispatch.toISOString() : null,
  };
}

/**
 * Just the identity of the actor's jobs (same set and order as `loadJobs`, which was being called by
 * the Today list, Command Center, Workspace and Welding only to read `id`, `jobNumber` and `status`).
 * One indexed query instead of the tallies, percent view, event join, hold points and spine view
 * `loadJobs` runs for every job (AUD-061). `onlyActive` is `loadJobs(...).filter(j => j.status === "ACTIVE")`.
 */
export async function loadJobRefs(
  actor: Actor,
  { onlyActive = false }: { onlyActive?: boolean } = {},
): Promise<{ id: number; jobNumber: string; status: string }[]> {
  return withTenant(actor.tenantId, (tx) =>
    tx.job.findMany({
      where: { ...(actor.clientId != null ? { clientId: actor.clientId } : {}), ...(onlyActive ? { status: "ACTIVE" as const } : {}) },
      select: { id: true, jobNumber: true, status: true },
      orderBy: { jobNumber: "asc" },
    }),
  );
}

export async function loadJobs(actor: Actor): Promise<JobListItem[]>;
export async function loadJobs(
  actor: Actor,
  opts: { page: number; pageSize: number },
): Promise<{ items: JobListItem[]; total: number; page: number; pageSize: number }>;
export async function loadJobs(
  actor: Actor,
  opts?: { page: number; pageSize: number },
): Promise<JobListItem[] | { items: JobListItem[]; total: number; page: number; pageSize: number }> {
  const { base, total } = await loadJobsBase(actor, opts, { shell: false });
  if (base.length === 0) return opts ? { items: [], total, page: opts.page, pageSize: opts.pageSize } : [];

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

  const items: JobListItem[] = base.map((j) => {
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
  return opts ? { items, total, page: opts.page, pageSize: opts.pageSize } : items;
}

/** duration-weighted % complete per job, from the one view every percent surface reads (see loadJobsBase). */
async function percentsOf(tx: Tx, jobIds: number[]): Promise<Map<number, string | number>> {
  const percents = await tx.$queryRaw<PercentRow[]>`
    SELECT job_id, sum(percent * weight) / sum(weight) AS percent
    FROM v_process_plan_percent
    WHERE job_id = ANY(${jobIds}::int[])
    GROUP BY job_id
  `;
  return new Map(percents.map((p) => [p.job_id, p.percent]));
}

/**
 * `percentComplete` of the jobs the shell lists, exactly as `loadJobs` computes it, but only when the
 * job switcher is opened (AUD-020): the view behind it walks every plan's mapped operations, so it
 * stays out of the layout that runs on every page. A job the actor cannot see is absent.
 */
export async function loadJobPercents(actor: Actor, jobIds: number[]): Promise<Record<number, number>> {
  if (jobIds.length === 0) return {};
  return withTenant(actor.tenantId, async (tx) => {
    const visible = await tx.job.findMany({
      where: { id: { in: jobIds }, ...(actor.clientId != null ? { clientId: actor.clientId } : {}) },
      select: { id: true },
    });
    const byJob = await percentsOf(tx, visible.map((j) => j.id));
    return Object.fromEntries(visible.map((j) => [j.id, Math.round(Number(byJob.get(j.id) ?? 0))]));
  });
}

/**
 * The shared first half of `loadJobs` and `loadShellJobs`: job rows + plan tallies + percent
 * (+ last activity unless `shell`). `shell` also picks the capped, ACTIVE-first job set.
 */
async function loadJobsBase(
  actor: Actor,
  opts: { page: number; pageSize: number } | undefined,
  { shell }: { shell: boolean },
): Promise<{ base: JobRow[]; total: number }> {
  return withTenant(actor.tenantId, async (tx) => {
    // Client-scoped users see only their own client's jobs; staff see all.
    const where = actor.clientId != null ? { clientId: actor.clientId } : undefined;
    const total = opts ? await tx.job.count({ where }) : 0;
    const jobSelect = {
      id: true,
      jobNumber: true,
      projectName: true,
      status: true,
      committedDeliveryDate: true,
      family: { select: { name: true } },
      equipments: { select: { _count: { select: { units: true } } } },
    } as const;
    let jobs;
    if (shell) {
      const active = await tx.job.findMany({ where: { ...where, status: "ACTIVE" }, select: jobSelect, orderBy: { jobNumber: "asc" }, take: SHELL_JOB_CAP });
      const room = SHELL_JOB_CAP - active.length;
      const others = room > 0 ? await tx.job.findMany({ where: { ...where, status: { not: "ACTIVE" } }, select: jobSelect, orderBy: { jobNumber: "asc" }, take: room }) : [];
      jobs = [...active, ...others].sort((a, b) => (a.jobNumber < b.jobNumber ? -1 : a.jobNumber > b.jobNumber ? 1 : 0));
    } else {
      jobs = await tx.job.findMany({
        where,
        select: jobSelect,
        orderBy: { jobNumber: "asc" },
        ...(opts ? { skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize } : {}),
      });
    }
    if (jobs.length === 0) return { base: [] as JobRow[], total };

    const jobIds = jobs.map((j) => j.id);
    const tallies = await tx.$queryRaw<TallyRow[]>`
      SELECT sr.job_id,
             count(*)::int AS total,
             count(*) FILTER (WHERE pp.status = 'COMPLETE')::int AS complete,
             count(*) FILTER (
               WHERE pp.status <> 'COMPLETE'
                 AND pp.planned_finish IS NOT NULL
                 AND pp.planned_finish < ist_day_marker(now())
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
    // The shell does not carry it (the view is the costliest read in the layout; see loadJobPercents).
    const percentByJob = shell ? new Map<number, string | number>() : await percentsOf(tx, jobIds);

    // The shell never shows last activity, and this is the join that scales with the whole event stream (AUD-020).
    // The shell never shows last activity, and this is the join that scales with the whole event stream (AUD-020).
    const activity = shell ? [] : await tx.$queryRaw<ActivityRow[]>`
      SELECT jp.job_id, max(de.at) AS last_at
      FROM domain_events de
      JOIN process_plans pp ON pp.id::text = de.aggregate_id
      JOIN job_processes jp ON jp.id = pp.job_process_id
      WHERE de.aggregate_type = 'ProcessPlan' AND jp.job_id = ANY(${jobIds}::int[])
      GROUP BY jp.job_id

      UNION ALL

      SELECT jp.job_id, max(de.at) AS last_at
      FROM domain_events de
      JOIN delay_reasons dr ON dr.id::text = de.aggregate_id
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

    const mapped = jobs.map((j) => {
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
    return { base: mapped, total };
  });
}
