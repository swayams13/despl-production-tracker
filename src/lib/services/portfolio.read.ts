import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { loadJobs, type JobListItem } from "./jobs.read";
import { classifyJobHealth, HEALTH_ORDER, type JobHealth } from "./job-health";
import { computeCpmSafe, getCurrentScheduleRunsBatch, loadJobSpinesBatch } from "./_shared";
import { prioritize } from "./prioritizer";
import { loadQcLists } from "./qc-queue.read";
import { ncrTenantScope } from "./ncr.service";
import {
  bottlenecks,
  buildExceptions,
  rankExceptions,
  type DeptBottleneck,
  type HoldFact,
  type NcrFact,
  type PlanFact,
  type PortfolioException,
  type PortfolioFacts,
} from "@/lib/shared/portfolio";
import { HOLD_STATUS_LABEL } from "@/lib/shared/qc-queue";

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
                    JOIN process_plans pp ON pp.id::text = de.aggregate_id
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
                     AND pp.planned_finish < ist_day_marker(now())) AS newly_overdue,
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
        j.committedDeliveryDate === null
          ? null
          : Math.round((new Date(j.committedDeliveryDate).getTime() - now.getTime()) / DAY_MS),
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

// ── L2.7: what the Portfolio's bars and queue are made of ─────────────────────

/**
 * One pass over the tenant's ACTIVE jobs for the Portfolio's operational half.
 * Plans come through the same spine -> CPM -> `prioritize()` pipeline the Team
 * page uses, so "blocked" and "overdue" mean on the tiles exactly what they
 * mean one click away. Holds and NCRs are the QC queue's own builders. The
 * department of an NCR is the department that did the rejected work.
 *
 * Tenant scoping: job ids come from `loadPortfolio` (tenant RLS); the child
 * tables (process plans, units) are only ever reached through those ids, and
 * the NCR scan goes through `ncrTenantScope`.
 *
 * ponytail: CPM + prioritize per active job, as myday / command-center do. Fine
 * at DESPL's 3-40 active jobs; batch if a tenant ever has hundreds.
 */
export async function loadPortfolioFacts(actor: Actor, rows: Pick<PortfolioRow, "id" | "jobNumber" | "status">[]): Promise<PortfolioFacts> {
  const active = rows.filter((r) => r.status === "ACTIVE");
  const jobIds = active.map((j) => j.id);
  const now = new Date();

  const [qc, base] = await Promise.all([
    loadQcLists(actor),
    withTenant(actor.tenantId, async (tx) => {
      const [depts, runs, spines, units, ncrDepts] = await Promise.all([
        tx.department.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, code: true, name: true } }),
        getCurrentScheduleRunsBatch(tx, jobIds),
        loadJobSpinesBatch(tx, jobIds),
        jobIds.length
          ? tx.unit.findMany({ where: { equipment: { jobId: { in: jobIds } } }, select: { id: true, serialNo: true } })
          : Promise.resolve([]),
        tx.ncr.findMany({
          where: { status: { not: "CLOSED" }, ...ncrTenantScope(actor.tenantId) },
          select: {
            id: true,
            componentOperationRejection: { select: { componentOperation: { select: { operation: { select: { defaultDepartmentId: true } } } } } },
            assemblyStepRejection: { select: { assemblyStep: { select: { templateStep: { select: { defaultDepartmentId: true } } } } } },
            targetComponentOperation: { select: { operation: { select: { defaultDepartmentId: true } } } },
            targetAssemblyStep: { select: { templateStep: { select: { defaultDepartmentId: true } } } },
          },
        }),
      ]);
      const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));

      const plans: PlanFact[] = [];
      const assigneeByPlan = new Map<number, number>();
      for (const job of active) {
        const run = runs.get(job.id);
        const spine = spines.get(job.id);
        if (!run || !spine) continue;
        // A malformed spine on one job must not take the whole Portfolio down.
        const cpm = computeCpmSafe(spine.processes, spine.edges);
        if (!cpm) continue;
        const ranked = prioritize({
          plans: run.processPlans,
          edges: spine.edges,
          floatByProcessId: new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }])),
          processNameById: new Map(spine.rawProcesses.map((p) => [p.id, p.name])),
          today: now,
        });
        const nameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));
        for (const list of ranked.values()) {
          for (const r of list) {
            if (r.state === "DONE") continue;
            const p = r.plan;
            if (p.assigneeUserId != null) assigneeByPlan.set(p.id, p.assigneeUserId);
            plans.push({
              planId: p.id,
              jobId: job.id,
              jobNumber: job.jobNumber,
              deptId: p.ownerDepartmentId,
              processName: nameById.get(p.jobProcessId) ?? `#${p.jobProcessId}`,
              serialNo: p.unitId != null ? (serialByUnit.get(p.unitId) ?? `#${p.unitId}`) : null,
              state: r.state,
              overdue: r.overdue,
              daysLate: r.overdue && p.plannedFinish ? Math.max(1, Math.ceil((now.getTime() - p.plannedFinish.getTime()) / 864e5)) : null,
              assigneeName: null,
            });
          }
        }
      }

      // Names only for the people on overdue plans: those are the rows that show an owner.
      const ids = [...new Set(plans.filter((p) => p.overdue).map((p) => assigneeByPlan.get(p.planId)).filter((x): x is number => x != null))];
      const users = ids.length ? await tx.user.findMany({ where: { tenantId: actor.tenantId, id: { in: ids } }, select: { id: true, name: true } }) : [];
      const userName = new Map(users.map((u) => [u.id, u.name]));
      for (const p of plans) {
        const uid = assigneeByPlan.get(p.planId);
        if (p.overdue && uid != null) p.assigneeName = userName.get(uid) ?? null;
      }

      const deptOfNcr = new Map(
        ncrDepts.map((n) => [
          n.id,
          n.componentOperationRejection?.componentOperation.operation.defaultDepartmentId ??
            n.assemblyStepRejection?.assemblyStep.templateStep.defaultDepartmentId ??
            n.targetComponentOperation?.operation.defaultDepartmentId ??
            n.targetAssemblyStep?.templateStep.defaultDepartmentId ??
            null,
        ]),
      );
      return { depts, plans, deptOfNcr };
    }),
  ]);

  // Holds and NCRs also count on a job that is ON_HOLD: paused work still has open quality items.
  const activeIds = new Set(rows.map((r) => r.id));
  const ncrs: NcrFact[] = qc.ncrs
    .filter((n) => activeIds.has(n.jobId))
    .map((n) => ({
      ncrId: n.ncrId,
      jobId: n.jobId,
      jobNumber: n.jobNumber,
      deptId: base.deptOfNcr.get(n.ncrId) ?? null,
      serialNo: n.serialNo,
      label: n.entityLabel,
      ageDays: n.ageDays,
    }));
  const holds: HoldFact[] = qc.holds
    .filter((h) => activeIds.has(h.jobId))
    .map((h) => ({
      key: h.key,
      jobId: h.jobId,
      jobNumber: h.jobNumber,
      serialNo: h.serialNo,
      label: h.activity,
      classCode: h.classCode,
      statusLabel: HOLD_STATUS_LABEL[h.status],
      ageDays: h.ageDays,
    }));
  return { depts: base.depts, plans: base.plans, ncrs, holds };
}

/** Department bars (blocked / overdue / rejected), worst first. Optionally one job. */
export async function loadPortfolioBottlenecks(actor: Actor, jobId: number | null = null): Promise<DeptBottleneck[]> {
  const { rows } = await loadPortfolio(actor);
  return bottlenecks(await loadPortfolioFacts(actor, rows), jobId);
}

/** The whole needs-attention queue, ranked worst job first (the page shows the top 15; the first per job is its top blocker). */
export async function loadPortfolioExceptions(actor: Actor, jobId: number | null = null): Promise<PortfolioException[]> {
  const { rows } = await loadPortfolio(actor);
  const facts = await loadPortfolioFacts(actor, rows);
  return rankExceptions(buildExceptions(facts, jobId), rows.map((r) => r.id));
}
