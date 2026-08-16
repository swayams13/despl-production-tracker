import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { computeCpm, workingDaysBetween } from "@/lib/schedule";
import { loadJobSpine, getCurrentScheduleRun } from "./_shared";
import { prioritize, compareRankedPlans, type RankedPlan } from "./prioritizer";
import { loadJobs } from "./jobs.read";

/**
 * `/my-day` (personal dashboards v1, SPEC §6.1) — the personalized read every
 * SUPERVISOR/QC employee lands on. No subject parameter (Phase 2 ruling,
 * `.superpowers/sdd/PLAN-personal-dashboards-v1/progress.md` "Phase 2"): this
 * always computes the CALLER's own view — a "view teammate's scoreboard"
 * capability is deferred to whichever future phase actually exposes it.
 *
 * Cross-job aggregation (same ruling): every ranking primitive
 * (`prioritize()`, and `loadWorkspaceView`/`loadJobKpis` which call it) is
 * job-scoped — it computes CPM float from one job's spine per call. This
 * follows `loadPortfolio()`'s (portfolio.read.ts) precedent: loop the actor's
 * active jobs, run the existing spine -> CPM -> `prioritize()` pipeline
 * unchanged for each, merge the ranked results, then partition and re-sort
 * globally with the prioritizer's own comparator (`compareRankedPlans`) —
 * no second ranking implementation.
 *
 * ponytail: N-jobs-worth of queries (spine + CPM + prioritize per active
 * job), same shape and same tradeoff `portfolio.read.ts` already flags —
 * fine at DESPL's 3-40 concurrently active jobs, batch before a tenant with
 * hundreds.
 */

export interface MyDayScoreboard {
  /** % of my COMPLETE plans (actualFinish in the last 30 days) finished on
   * or before their plannedFinish. Null when nothing of mine completed in
   * the window — same "no data yet" convention as loadJobKpis's
   * firstPassYieldPct, not 0 (which would read as "always late"). */
  onTimePct30d: number | null;
  /** My COMPLETE plans with actualFinish in the last rolling 7 days — same
   * rolling window loadJobKpis's `stagesVerified7d` uses (not a Mon-Sun
   * calendar week). */
  doneThisWeek: number;
  /** Avg (actual working days − standard working days) over my COMPLETE
   * plans with both actualStart/actualFinish known — identical formula to
   * loadJobKpis's avgCycleVsStandardDays (SPEC §6.3 SQL-view rule), filtered
   * to my assignments instead of a job's plans. Positive = running long. */
  avgCycleVsStdDays: number | null;
  /** Count of ProcessRejected events against my plans in the last 30 days
   * (each rejection occurrence, not distinct plans — a plan bounced back
   * twice counts twice). */
  firstPassRejects30d: number;
}

export interface MyDayWeekDay {
  /** IST calendar day, "YYYY-MM-DD". */
  date: string;
  mineCount: number;
  poolCount: number;
  /** Of that day's mine+pool items, how many are overdue or on the critical
   * path — the spec names this field without defining "hot"; this is the
   * reading used, flagged for confirmation. */
  hotCount: number;
}

export interface MyDayView {
  mine: RankedPlan[];
  pool: RankedPlan[];
  teamHeld: RankedPlan[];
  clearedToday: number;
  scoreboard: MyDayScoreboard;
  week: MyDayWeekDay[];
}

/** IST (UTC+5:30) calendar-day bounds for `now` shifted by `offsetDays` —
 * same fixed-offset convention reports.read.ts's istDayRange uses, just
 * date-math'd from a live `now` instead of a literal ISO date string. */
function istDay(now: Date, offsetDays: number): { start: Date; end: Date; date: string } {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  ist.setUTCDate(ist.getUTCDate() + offsetDays);
  const date = ist.toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end, date };
}

export async function loadMyDay(actor: Actor): Promise<MyDayView> {
  const now = new Date();
  const jobs = (await loadJobs(actor)).filter((j) => j.status === "ACTIVE");

  const mine: RankedPlan[] = [];
  const pool: RankedPlan[] = [];
  const teamHeld: RankedPlan[] = [];

  // Scoreboard accumulators — over MY COMPLETE plans in the same active-job
  // universe as mine/pool/teamHeld (ponytail: reuses each job's spine/
  // calendar/durationMaxById, already loaded for CPM below, instead of a
  // second query path for one field; a job that flips to COMPLETE/CANCELLED
  // drops its last completions out of the 30d/7d windows the day it leaves
  // ACTIVE — acceptable at pilot scale, revisit if that ever confuses a real
  // scoreboard).
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  let onTimeCount = 0;
  let onTimeTotal = 0;
  let doneThisWeek = 0;
  const cycleDeltas: number[] = [];
  const myPlanIds: number[] = [];

  const { start: todayStart, end: todayEnd } = istDay(now, 0);

  const clearedToday = await withTenant(actor.tenantId, async (tx) => {
    for (const job of jobs) {
      const run = await getCurrentScheduleRun(tx, job.id, null);
      if (!run) continue;

      const spine = await loadJobSpine(tx, job.id);
      const cpm = computeCpm(spine.processes, spine.edges);
      const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
      const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));
      const durationMaxById = new Map(spine.rawProcesses.map((p) => [p.id, p.durationMaxDays]));

      const rankedByDept = prioritize({
        plans: run.processPlans,
        edges: spine.edges,
        floatByProcessId,
        processNameById,
        today: now,
      });

      // Partition: mine wins regardless of department (an assignee never
      // loses "mine" just because they were later moved off that dept);
      // otherwise only rows in a department the actor belongs to are in
      // scope at all — cross-department is aggregate-only (D14, not this
      // function's job). Disjoint by construction: assigneeUserId is exactly
      // one of {actor.userId, null, someone else}.
      for (const rows of rankedByDept.values()) {
        for (const r of rows) {
          if (r.state === "DONE") continue; // actionable/live boards only, not a history log
          const assignee = r.plan.assigneeUserId;
          if (assignee === actor.userId) {
            mine.push(r);
          } else if (actor.departmentIds.includes(r.plan.ownerDepartmentId)) {
            if (assignee == null) pool.push(r);
            else teamHeld.push(r);
          }
        }
      }

      // Scoreboard source rows: every plan assigned to me in this run.
      for (const p of run.processPlans) {
        if (p.assigneeUserId !== actor.userId) continue;
        myPlanIds.push(p.id);
        if (p.status !== "COMPLETE") continue;
        if (p.actualFinish && p.plannedFinish && p.actualFinish >= thirtyDaysAgo) {
          onTimeTotal++;
          if (p.actualFinish <= p.plannedFinish) onTimeCount++;
        }
        if (p.actualFinish && p.actualFinish >= sevenDaysAgo) doneThisWeek++;
        if (p.actualStart && p.actualFinish) {
          const standard = durationMaxById.get(p.jobProcessId);
          if (standard != null) {
            const actualDays = workingDaysBetween(p.actualStart, p.actualFinish, spine.calendar);
            cycleDeltas.push(actualDays - standard);
          }
        }
      }
    }

    // clearedToday (SPEC §6.1): my items COMPLETE or SUBMITTED today, server
    // date. COMPLETE uses actualFinish (server-clock, invariant #1) directly;
    // SUBMITTED has no timestamp column on ProcessPlan, so it reads the
    // ProcessSubmitted domain event instead (same event-sourced pattern
    // loadJobKpis's eventCounts / reports.read.ts use for "did X happen
    // today"). Scoped by assigneeUserId = actor.userId directly on
    // process_plans (safe with no extra tenant join: assigneeUserId can only
    // ever equal this specific, already-tenant-resolved user id — see
    // lockProcessPlanForUpdate's comment on why process_plans itself carries
    // no RLS).
    const completedTodayCount = await tx.processPlan.count({
      where: {
        assigneeUserId: actor.userId,
        status: "COMPLETE",
        actualFinish: { gte: todayStart, lt: todayEnd },
      },
    });
    const submittedTodayRows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT pp.id)::int AS n
      FROM process_plans pp
      JOIN domain_events de ON de.aggregate_type = 'ProcessPlan' AND de.aggregate_id = pp.id::text
      WHERE pp.assignee_user_id = ${actor.userId}
        AND pp.status = 'SUBMITTED'
        AND de.type = 'ProcessSubmitted'
        AND de.at >= ${todayStart} AND de.at < ${todayEnd}
    `;
    return completedTodayCount + (submittedTodayRows[0]?.n ?? 0);
  });

  mine.sort(compareRankedPlans);
  pool.sort(compareRankedPlans);
  teamHeld.sort(compareRankedPlans);

  const firstPassRejects30d = await withTenant(actor.tenantId, async (tx) => {
    if (myPlanIds.length === 0) return 0;
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM domain_events de
      WHERE de.aggregate_type = 'ProcessPlan'
        AND de.type = 'ProcessRejected'
        AND de.at >= ${thirtyDaysAgo}
        AND de.aggregate_id = ANY(${myPlanIds.map(String)}::text[])
    `;
    return rows[0]?.n ?? 0;
  });

  const scoreboard: MyDayScoreboard = {
    onTimePct30d: onTimeTotal > 0 ? Math.round((onTimeCount / onTimeTotal) * 100) : null,
    doneThisWeek,
    avgCycleVsStdDays:
      cycleDeltas.length > 0
        ? Math.round((cycleDeltas.reduce((a, b) => a + b, 0) / cycleDeltas.length) * 10) / 10
        : null,
    firstPassRejects30d,
  };

  // week (SPEC §6.1): T+0..T+5, six IST calendar days, bucketed by
  // plannedFinish over the same mine/pool rows already collected above.
  const week: MyDayWeekDay[] = [];
  for (let offset = 0; offset <= 5; offset++) {
    const { start, end, date } = istDay(now, offset);
    let mineCount = 0;
    let poolCount = 0;
    let hotCount = 0;
    for (const r of mine) {
      if (r.plan.plannedFinish && r.plan.plannedFinish >= start && r.plan.plannedFinish < end) {
        mineCount++;
        if (r.overdue || r.criticalPath) hotCount++;
      }
    }
    for (const r of pool) {
      if (r.plan.plannedFinish && r.plan.plannedFinish >= start && r.plan.plannedFinish < end) {
        poolCount++;
        if (r.overdue || r.criticalPath) hotCount++;
      }
    }
    week.push({ date, mineCount, poolCount, hotCount });
  }

  return { mine, pool, teamHeld, clearedToday, scoreboard, week };
}
