import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { loadJobs, type JobListItem } from "./jobs.read";
import { classifyJobHealth, HEALTH_ORDER, type JobHealth } from "./job-health";

/**
 * Portfolio view for the management dashboard (§4.2) — every project's health
 * in one payload, worst-first, so the morning meeting does not have to open
 * each job in turn.
 *
 * Composes `loadJobs()` (which already computes every health input) with the
 * canonical rule in `job-health.ts`. No new aggregate query and no SQL view:
 * a second definition of "overdue" is exactly the drift DESIGN_SPEC §11.5
 * warns about.
 *
 * ponytail: `loadJobs()`'s extras (open hold points + spine, two queries per
 * job) make this roughly 2N+3 queries. Fine at DESPL's 3-40 concurrently
 * active jobs; batch those two reads before a tenant with hundreds.
 */
export interface PortfolioRow extends JobListItem {
  health: JobHealth;
  clientName: string;
  /** Negative once the promised date has passed. Null when no date is set. */
  daysToPromise: number | null;
  verifiedLast24h: number;
  newlyOverdueLast24h: number;
  holdsOpenedLast24h: number;
}

export interface Portfolio {
  counts: Record<JobHealth, number> & { active: number };
  rows: PortfolioRow[];
  /** Cancelled jobs are excluded from tiles and rows — surfaced, never silently dropped. */
  cancelledCount: number;
}

interface ChangeRow {
  job_id: number;
  verified: number;
  newly_overdue: number;
  holds_opened: number;
}

const DAY_MS = 86_400_000;

export async function loadPortfolio(actor: Actor): Promise<Portfolio> {
  const jobs = await loadJobs(actor);
  const now = new Date();

  const extra = await withTenant(actor.tenantId, async (tx) => {
    const jobIds = jobs.map((j) => j.id);

    const clients = await tx.job.findMany({
      where: { id: { in: jobIds } },
      select: { id: true, client: { select: { name: true } } },
    });
    const clientByJob = new Map(clients.map((c) => [c.id, c.client.name]));

    // Rolling 24h, NOT an IST calendar day. The meeting is a rolling cadence
    // ("what changed since we last met"), so the window must not reset to zero
    // at 00:00 IST while people are still working. `loadDailyDigest` uses IST
    // calendar days because it is a dated report — the difference is deliberate.
    const changes = jobIds.length
      ? await tx.$queryRaw<ChangeRow[]>`
          WITH win AS (SELECT (now() AT TIME ZONE 'UTC') - interval '24 hours' AS since)
          SELECT j.id AS job_id,
                 (SELECT count(*)::int
                    FROM domain_events de
                    JOIN process_plans pp ON pp.id = de.aggregate_id::int
                    JOIN job_processes jp ON jp.id = pp.job_process_id
                   WHERE de.aggregate_type = 'ProcessPlan'
                     AND de.type = 'ProcessVerified'
                     AND jp.job_id = j.id
                     AND de.at >= (SELECT since FROM win)) AS verified,
                 (SELECT count(*)::int
                    FROM process_plans pp
                    JOIN schedule_runs sr ON sr.id = pp.schedule_run_id AND sr.is_current = true
                   WHERE sr.job_id = j.id
                     AND pp.status <> 'COMPLETE'
                     AND pp.planned_finish >= (SELECT since FROM win)
                     AND pp.planned_finish < (now() AT TIME ZONE 'UTC')) AS newly_overdue,
                 -- Same predicate as loadDailyDigest's "holds opened" (reports.read.ts):
                 -- a gated process (one carrying a blocks_completion QCP code) that
                 -- STARTED in the window. There is no "hold opened" event; the process
                 -- crossing NOT_STARTED -> IN_PROGRESS is the closest real signal that
                 -- its hold point's clock started. Only the window differs — rolling
                 -- 24h here, IST calendar day in the digest (spec §5.3).
                 (SELECT count(DISTINCT pp.id)::int
                    FROM process_plans pp
                    JOIN job_processes jp ON jp.id = pp.job_process_id
                    JOIN qcp_item_processes qip ON qip.job_process_id = pp.job_process_id
                    JOIN qcp_item_party_codes qipc ON qipc.qcp_item_id = qip.qcp_item_id
                    JOIN qcp_code_refs qcr ON qcr.id = qipc.qcp_code_id AND qcr.blocks_completion = true
                   WHERE jp.job_id = j.id
                     AND pp.actual_start >= (SELECT since FROM win)
                     AND pp.actual_start < (now() AT TIME ZONE 'UTC')) AS holds_opened
          FROM jobs j
          WHERE j.id = ANY(${jobIds}::int[])
        `
      : [];

    return { clientByJob, changeByJob: new Map(changes.map((c) => [c.job_id, c])) };
  });

  const counts = {
    active: 0,
    ON_TRACK: 0,
    AT_RISK: 0,
    DELAYED: 0,
    ON_HOLD: 0,
    COMPLETED: 0,
    NOT_PLANNED: 0,
  };
  const rows: PortfolioRow[] = [];
  let cancelledCount = 0;

  for (const j of jobs) {
    const health = classifyJobHealth(j, now);
    if (health === "CANCELLED") {
      cancelledCount += 1;
      continue;
    }

    const c = extra.changeByJob.get(j.id);
    counts[health] += 1;
    if (j.status === "ACTIVE") counts.active += 1;

    rows.push({
      ...j,
      health,
      clientName: extra.clientByJob.get(j.id) ?? "—",
      daysToPromise:
        j.deliveryDate === null
          ? null
          : Math.round((new Date(j.deliveryDate).getTime() - now.getTime()) / DAY_MS),
      verifiedLast24h: c?.verified ?? 0,
      newlyOverdueLast24h: c?.newly_overdue ?? 0,
      holdsOpenedLast24h: c?.holds_opened ?? 0,
    });
  }

  // Worst-first, then most-overdue-first inside a bucket, then stable by job number.
  rows.sort((a, b) => {
    const byHealth = HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health);
    if (byHealth !== 0) return byHealth;
    const ad = a.daysToPromise ?? Number.POSITIVE_INFINITY;
    const bd = b.daysToPromise ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.jobNumber.localeCompare(b.jobNumber);
  });

  return { counts, rows, cancelledCount };
}
