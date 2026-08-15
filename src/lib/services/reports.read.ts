import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { loadJobs } from "./jobs.read";
import type { StageSegment } from "@/components/industrial/stage-status";

/**
 * `/reports` daily digest (§4.9). Generated fresh from real events for a
 * selected date — never a stored/static document. Per-job mini-spine reuses
 * `loadJobs`' already-computed `unitRollup` (current live state, not a
 * point-in-time snapshot — `ProgressSnapshot` has zero rows in this seed, the
 * same gap §9.4's dashboard log already documented, so a historical spine
 * isn't available; the date-scoped counts below ARE real history, read from
 * `domain_events`/`qcp_executions`/`delay_reasons`, which is what the spec's
 * acceptance check actually exercises: "digest for 'yesterday' renders
 * correctly from seeded events").
 */
export interface JobDigestRow {
  jobId: number;
  jobNumber: string;
  familyName: string;
  spine: StageSegment[];
  stagesVerifiedToday: number;
  newOverdueCount: number;
  newOverdueReasons: string[];
}

export interface DueTomorrowRow {
  jobNumber: string;
  unitLabel: string;
  processName: string;
}

export interface DailyDigest {
  date: string;
  jobs: JobDigestRow[];
  holdsOpened: number;
  holdsCleared: number;
  tomorrowDue: DueTomorrowRow[];
}

/** `date` is an IST calendar day ("YYYY-MM-DD"); IST = UTC+5:30. */
function istDayRange(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}

export async function loadDailyDigest(actor: Actor, date: string): Promise<DailyDigest> {
  const { start, end } = istDayRange(date);
  const tomorrow = new Date(end.getTime() + 24 * 3600 * 1000);

  const jobList = await loadJobs(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const jobIds = jobList.map((j) => j.id);

    // ── stages verified today, per job (process-grain event count) ───────
    const verifiedRows = jobIds.length
      ? await tx.$queryRaw<{ job_id: number; n: number }[]>`
          SELECT jp.job_id, count(*)::int AS n
          FROM domain_events de
          JOIN process_plans pp ON pp.id::text = de.aggregate_id AND de.aggregate_type = 'ProcessPlan'
          JOIN job_processes jp ON jp.id = pp.job_process_id
          WHERE de.type = 'ProcessVerified' AND de.at >= ${start} AND de.at < ${end}
            AND jp.job_id = ANY(${jobIds})
          GROUP BY jp.job_id
        `
      : [];
    const verifiedByJob = new Map(verifiedRows.map((r) => [r.job_id, r.n]));

    // ── plans whose due date falls on this day and are still not complete ─
    const overdueRows = jobIds.length
      ? await tx.processPlan.findMany({
          where: {
            plannedFinish: { gte: start, lt: end },
            status: { not: "COMPLETE" },
            scheduleRun: { isCurrent: true },
            jobProcess: { jobId: { in: jobIds } },
          },
          select: {
            id: true,
            jobProcess: { select: { jobId: true } },
            delayReasons: { select: { category: { select: { name: true } } } },
          },
        })
      : [];
    const overdueByJob = new Map<number, { count: number; reasons: Set<string> }>();
    for (const p of overdueRows) {
      const jobId = p.jobProcess.jobId;
      const bucket = overdueByJob.get(jobId) ?? { count: 0, reasons: new Set<string>() };
      bucket.count++;
      for (const r of p.delayReasons) bucket.reasons.add(r.category.name);
      overdueByJob.set(jobId, bucket);
    }

    const jobs: JobDigestRow[] = jobList.map((j) => ({
      jobId: j.id,
      jobNumber: j.jobNumber,
      familyName: j.familyName,
      spine: j.unitRollup,
      stagesVerifiedToday: verifiedByJob.get(j.id) ?? 0,
      newOverdueCount: overdueByJob.get(j.id)?.count ?? 0,
      newOverdueReasons: [...(overdueByJob.get(j.id)?.reasons ?? [])],
    }));

    // ── holds cleared today: a real event (QcpExecution ACCEPTED/NA).
    //    QcpExecution carries no tenant_id (child-table reachability, no RLS
    //    of its own — see notifications.service.ts's identical fix), so this
    //    is explicitly scoped through the tenant's own job ids rather than
    //    left to scan every tenant in the DB. ─────────────────────────────
    const holdsCleared = jobIds.length
      ? await tx.qcpExecution.count({
          where: {
            result: { in: ["ACCEPTED", "NA"] },
            recordedAt: { gte: start, lt: end },
            qcpItem: { processLinks: { some: { jobProcess: { jobId: { in: jobIds } } } } },
          },
        })
      : 0;

    // ── holds opened today: proxy — a gated process started that day
    //    (no "hold opened" event exists; the process crossing NOT_STARTED →
    //    IN_PROGRESS is the closest real signal that its hold point's clock
    //    started, same "no direct signal" reasoning as §9.7's rejects-by-
    //    checkpoint substitution). Scoped to this tenant's job ids — same
    //    reachability caveat as holdsCleared above. ─────────────────────
    const holdsOpenedRows = jobIds.length
      ? await tx.$queryRaw<{ n: number }[]>`
          SELECT count(DISTINCT pp.id)::int AS n
          FROM process_plans pp
          JOIN job_processes jp ON jp.id = pp.job_process_id
          JOIN qcp_item_processes qip ON qip.job_process_id = pp.job_process_id
          JOIN qcp_item_party_codes qipc ON qipc.qcp_item_id = qip.qcp_item_id
          JOIN qcp_code_refs qcr ON qcr.id = qipc.qcp_code_id AND qcr.blocks_completion = true
          WHERE pp.actual_start >= ${start} AND pp.actual_start < ${end}
            AND jp.job_id = ANY(${jobIds})
        `
      : [];
    const holdsOpened = holdsOpenedRows[0]?.n ?? 0;

    // ── tomorrow's due list, across every job ─────────────────────────────
    const dueRows = await tx.processPlan.findMany({
      where: { plannedFinish: { gte: end, lt: tomorrow }, status: { not: "COMPLETE" } },
      select: {
        jobProcess: { select: { name: true, job: { select: { jobNumber: true } } } },
        unit: { select: { serialNo: true } },
      },
      orderBy: { plannedFinish: "asc" },
      take: 50,
    });
    const tomorrowDue: DueTomorrowRow[] = dueRows.map((p) => ({
      jobNumber: p.jobProcess.job.jobNumber,
      unitLabel: p.unit ? `Unit ${p.unit.serialNo}` : "—",
      processName: p.jobProcess.name,
    }));

    return { date, jobs, holdsOpened, holdsCleared, tomorrowDue };
  });
}

export interface DigestHistoryEntry {
  date: string;
  sentAt: string;
}

/** Dates a digest was actually "Sent" — derived from DIGEST_PUBLISHED notifications, no new table. */
export async function loadDigestHistory(actor: Actor): Promise<DigestHistoryEntry[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.notification.findMany({
      where: { type: "DIGEST_PUBLISHED" },
      distinct: ["entityId"],
      orderBy: { createdAt: "desc" },
      select: { entityId: true, createdAt: true, payload: true },
      take: 30,
    });
    return rows.map((r) => ({
      date: (r.payload as { date?: string } | null)?.date ?? "",
      sentAt: r.createdAt.toISOString(),
    }));
  });
}
