import { withTenant } from "@/lib/db";
import { hasRole, ROLES, type Actor } from "@/lib/authz";
import { workingDaysBetween } from "@/lib/schedule";
import { loadJobSpine, getCurrentScheduleRun, computeCpmSafe } from "./_shared";
import { prioritize, compareRankedPlans, type RankedPlan } from "./prioritizer";
import { loadJobs } from "./jobs.read";
import { stageLabel } from "./workspace.read";
import { isOnTime } from "@/lib/shared/business-day";

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

/**
 * A ranked plan with the display fields `/my-day` needs to render a
 * cross-job row without the client re-deriving them — same denormalize-in-
 * the-read-function convention `workspace.read.ts`'s `WsUnitRow`/`WsCard`
 * use, extended with `jobId`/`jobNumber` since this view spans jobs (task
 * 2.3 ruling, `.superpowers/sdd/PLAN-personal-dashboards-v1/progress.md`
 * "Task 2.3 — pre-dispatch rulings"). `stageNo` is the row's StageSheet
 * launch key (`useStageSheetLauncher().openStage(jobId, unitId, stageNo)`),
 * same convention as `qc-cockpit.read.ts`'s `QcQueueRow`/`departments.read.ts`'s
 * `DeptOpenItem` (`workOrderStages[0] ?? 0`).
 */
export interface MyDayRow {
  ranked: RankedPlan;
  jobId: number;
  jobNumber: string;
  processName: string;
  serialNo: string;
  stageLabel: string;
  stageNo: number;
  deptName: string;
  /** The holding teammate's display name — only ever set on `teamHeld` rows
   * (SPEC §7.2 bullet 6, "avatar + status"); null on `mine`/`pool` rows,
   * where it isn't rendered. Backfilled after the per-job loop (below) in
   * one query, not per-row. */
  assigneeName: string | null;
}

export interface MyDayView {
  mine: MyDayRow[];
  pool: MyDayRow[];
  teamHeld: MyDayRow[];
  /** My own COMPLETE plans, actualFinish in the last 30 days — same window
   * the scoreboard's onTimePct30d/avgCycleVsStdDays use. Read-only history,
   * not part of the actionable mine/pool/teamHeld boards. */
  completed: MyDayRow[];
  clearedToday: number;
  scoreboard: MyDayScoreboard;
  week: MyDayWeekDay[];
  /** Department id -> active staff members, for the "Assign to…" select on
   * pool rows (SPEC §7.2 bullet 5, supervisors only). Populated only when
   * the actor holds an assign-capable role — empty otherwise, safe to
   * render unconditionally. */
  deptMembers: Record<number, { id: number; name: string }[]>;
  /** Active delay-reason categories, for the row-level "File reason & start"
   * flow on overdue `mine` rows — same list `workspace.read.ts`'s
   * `WorkspaceView.delayCategories` carries, one tenant-wide query. */
  delayCategories: { id: number; name: string }[];
}

/** IST (UTC+5:30) calendar-day bounds for `now` shifted by `offsetDays` —
 * same fixed-offset convention reports.read.ts's istDayRange uses, just
 * date-math'd from a live `now` instead of a literal ISO date string.
 * Exported for command-center.read.ts (task 3.1 ruling) to reuse verbatim
 * instead of reintroducing browser-local time. */
export function istDay(now: Date, offsetDays: number): { start: Date; end: Date; date: string } {
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
  // QC verifies cross-department (workspace.read.ts's `qcQueue` — "SUBMITTED
  // plans across ALL departments"). Without this, a QC actor whose only
  // department is QC itself would never see a SUBMITTED plan owned by any
  // OTHER department in mine/pool/teamHeld, and `/my-day`'s "With QC" tab
  // (client-derived from those three arrays, `_client.tsx`'s `qcQueueRows`)
  // would come up empty for the exact maker-checker verification flow it
  // exists to surface.
  const isQcActor = hasRole(actor, ROLES.QC);

  const mine: MyDayRow[] = [];
  const pool: MyDayRow[] = [];
  const teamHeld: MyDayRow[] = [];
  const completed: MyDayRow[] = [];

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
  // Current-run ids of the actor's ACTIVE jobs only — clearedToday/
  // firstPassRejects30d scope their queries to this same universe so the
  // whole payload agrees on "what counts", instead of clearedToday quietly
  // reading the whole tenant while everything else reads ACTIVE jobs only.
  const activeRunIds: number[] = [];

  const { start: todayStart, end: todayEnd } = istDay(now, 0);

  const { clearedToday, firstPassRejects30d, deptMembers, delayCategories } = await withTenant(actor.tenantId, async (tx) => {
    // Loaded once, not per job — every job in the tenant shares the same
    // department table (task 2.3 ruling: additive display-label lookups
    // alongside the existing per-job loop, same shape as workspace.read.ts's
    // own department/unit lookups).
    const departments = await tx.department.findMany({ select: { id: true, name: true } });
    const deptNameById = new Map(departments.map((d) => [d.id, d.name]));

    for (const job of jobs) {
      const run = await getCurrentScheduleRun(tx, job.id, null);
      if (!run) continue;

      const spine = await loadJobSpine(tx, job.id);
      // A malformed spine (cycle, dangling edge, excluded provisional process
      // with no confirmed duration) on ANY one job must not 500 My Day for the
      // whole tenant — skip just this job's contribution (audit H2/0.10).
      const cpm = computeCpmSafe(spine.processes, spine.edges);
      if (!cpm) continue;
      activeRunIds.push(run.id);
      const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
      const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));
      const durationMaxById = new Map(spine.rawProcesses.map((p) => [p.id, p.durationMaxDays]));
      // Display metadata per process — same denormalization workspace.read.ts's
      // `procMeta` does, plus `stageNo` for the StageSheet launch key.
      const procMeta = new Map(
        spine.rawProcesses.map((p) => [p.id, { name: p.name, stageLabel: stageLabel(p.workOrderStages), stageNo: p.workOrderStages[0] ?? 0 }]),
      );
      const units = await tx.unit.findMany({ where: { equipment: { jobId: job.id } }, select: { id: true, serialNo: true } });
      const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));

      const rankedByDept = prioritize({
        plans: run.processPlans,
        edges: spine.edges,
        floatByProcessId,
        processNameById,
        today: now,
      });

      const toRow = (r: RankedPlan): MyDayRow => {
        const meta = procMeta.get(r.plan.jobProcessId);
        return {
          ranked: r,
          jobId: job.id,
          jobNumber: job.jobNumber,
          processName: meta?.name ?? processNameById.get(r.plan.jobProcessId) ?? `#${r.plan.jobProcessId}`,
          serialNo: r.plan.unitId != null ? (serialByUnit.get(r.plan.unitId) ?? `#${r.plan.unitId}`) : "—",
          stageLabel: meta?.stageLabel ?? "—",
          stageNo: meta?.stageNo ?? 0,
          deptName: deptNameById.get(r.plan.ownerDepartmentId) ?? `#${r.plan.ownerDepartmentId}`,
          assigneeName: null, // backfilled for teamHeld rows only, after the per-job loop below
        };
      };

      // Partition: mine wins regardless of department (an assignee never
      // loses "mine" just because they were later moved off that dept);
      // otherwise only rows in a department the actor belongs to are in
      // scope at all — cross-department is aggregate-only (D14, not this
      // function's job), EXCEPT the QC-verification bypass below (QC's
      // department-crossing duty is a named exception, not a hole in D14).
      // Disjoint by construction: each branch is `else if`, so a row can
      // only ever land in exactly one of mine/pool/teamHeld.
      for (const rows of rankedByDept.values()) {
        for (const r of rows) {
          const assignee = r.plan.assigneeUserId;
          if (r.state === "DONE") {
            // Completed history, not an actionable board — mine only (not
            // pool/teamHeld, which have no "someone else's completed" concept
            // here), same 30-day window as the scoreboard above.
            if (assignee === actor.userId && r.plan.actualFinish && r.plan.actualFinish >= thirtyDaysAgo) {
              completed.push(toRow(r));
            }
            continue;
          }
          if (assignee === actor.userId) {
            mine.push(toRow(r));
          } else if (actor.departmentIds.includes(r.plan.ownerDepartmentId)) {
            if (assignee == null) pool.push(toRow(r));
            else teamHeld.push(toRow(r));
          } else if (isQcActor && r.state === "SUBMITTED") {
            // Outside the actor's own department but awaiting QC verification —
            // route into teamHeld so the "With QC" tab's cross-dept filter has
            // something to find. assigneeUserId is usually the maker who
            // submitted it, but not guaranteed non-null — assignment.service
            // is the sole writer of that column (D16) and a plan can be
            // started/submitted by a supervisor without ever being claimed.
            teamHeld.push(toRow(r));
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
          if (isOnTime(p.actualFinish, p.plannedFinish)) onTimeCount++;
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

    // Backfill teamHeld.assigneeName — one query across every job's teamHeld
    // rows, not per-row/per-job (assignees are tenant users, not job-scoped).
    const teamHeldAssigneeIds = [...new Set(teamHeld.map((r) => r.ranked.plan.assigneeUserId).filter((x): x is number => x != null))];
    if (teamHeldAssigneeIds.length > 0) {
      const assigneeUsers = await tx.user.findMany({ where: { id: { in: teamHeldAssigneeIds } }, select: { id: true, name: true } });
      const nameByAssignee = new Map(assigneeUsers.map((u) => [u.id, u.name]));
      for (const row of teamHeld) {
        const uid = row.ranked.plan.assigneeUserId;
        row.assigneeName = uid != null ? (nameByAssignee.get(uid) ?? null) : null;
      }
    }

    // clearedToday (SPEC §6.1): my items COMPLETE or SUBMITTED today, server
    // date, scoped to the same ACTIVE-job/current-run universe as
    // mine/pool/teamHeld and the scoreboard (activeRunIds, built above —
    // superseded runs keep their ProcessPlan rows per persistScheduleRun's
    // own invariant #6, so an unscoped query here would count completions
    // from a run nobody can act on anymore). COMPLETE uses actualFinish
    // (server-clock, invariant #1) directly; SUBMITTED has no timestamp
    // column on ProcessPlan, so it reads the ProcessSubmitted domain event
    // instead (same event-sourced pattern loadJobKpis's eventCounts /
    // reports.read.ts use for "did X happen today").
    const completedTodayCount = activeRunIds.length
      ? await tx.processPlan.count({
          where: {
            assigneeUserId: actor.userId,
            status: "COMPLETE",
            actualFinish: { gte: todayStart, lt: todayEnd },
            scheduleRunId: { in: activeRunIds },
          },
        })
      : 0;
    const submittedTodayRows = activeRunIds.length
      ? await tx.$queryRaw<{ n: number }[]>`
          SELECT count(DISTINCT pp.id)::int AS n
          FROM process_plans pp
          JOIN domain_events de ON de.aggregate_type = 'ProcessPlan' AND de.aggregate_id = pp.id::text
          WHERE pp.assignee_user_id = ${actor.userId}
            AND pp.status = 'SUBMITTED'
            AND pp.schedule_run_id = ANY(${activeRunIds}::int[])
            AND de.type = 'ProcessSubmitted'
            AND de.at >= ${todayStart} AND de.at < ${todayEnd}
        `
      : [];
    const clearedToday = completedTodayCount + (submittedTodayRows[0]?.n ?? 0);

    // firstPassRejects30d: already scoped to the active-job universe via
    // myPlanIds (only ever populated from `run.processPlans` inside this
    // same active-job loop, above) — no separate scoping needed here.
    const rejectRows = myPlanIds.length
      ? await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n
          FROM domain_events de
          WHERE de.aggregate_type = 'ProcessPlan'
            AND de.type = 'ProcessRejected'
            AND de.at >= ${thirtyDaysAgo}
            AND de.aggregate_id = ANY(${myPlanIds.map(String)}::text[])
        `
      : [];
    const firstPassRejects30d = rejectRows[0]?.n ?? 0;

    // deptMembers (SPEC §7.2 bullet 5): the "Assign to…" select's option
    // list, department -> active staff. Every pool/teamHeld row an
    // assign-capable actor can actually see is in one of actor.departmentIds
    // (the partition rule above) — a QC actor's cross-dept teamHeld rows
    // (the branch above) are the one exception, but that's moot here since
    // this block is gated on an assign-capable role, not QC, so one query
    // keyed by the actor's own departments still covers every row this actor
    // could ever assign from. Assign-capable roles only — a QC-only actor
    // gets an empty map (safe: the UI simply never renders the select
    // without an assign-capable role, same gate `assignPlan` itself enforces
    // server-side).
    const deptMembers: Record<number, { id: number; name: string }[]> = {};
    if (actor.departmentIds.length > 0 && hasRole(actor, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN)) {
      const memberRows = await tx.userDepartment.findMany({
        where: { departmentId: { in: actor.departmentIds }, user: { active: true, clientId: null } },
        select: { departmentId: true, user: { select: { id: true, name: true } } },
      });
      for (const m of memberRows) {
        (deptMembers[m.departmentId] ??= []).push({ id: m.user.id, name: m.user.name });
      }
    }

    const delayCategories = await tx.delayCategoryRef.findMany({ where: { active: true }, select: { id: true, name: true } });

    return { clearedToday, firstPassRejects30d, deptMembers, delayCategories };
  });

  mine.sort((a, b) => compareRankedPlans(a.ranked, b.ranked));
  pool.sort((a, b) => compareRankedPlans(a.ranked, b.ranked));
  teamHeld.sort((a, b) => compareRankedPlans(a.ranked, b.ranked));
  // Most recently finished first — compareRankedPlans is an urgency ordering
  // (float/overdue/due-date) that doesn't apply to already-DONE rows.
  completed.sort((a, b) => (b.ranked.plan.actualFinish?.getTime() ?? 0) - (a.ranked.plan.actualFinish?.getTime() ?? 0));

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
    for (const row of mine) {
      const r = row.ranked;
      if (r.plan.plannedFinish && r.plan.plannedFinish >= start && r.plan.plannedFinish < end) {
        mineCount++;
        if (r.overdue || r.criticalPath) hotCount++;
      }
    }
    for (const row of pool) {
      const r = row.ranked;
      if (r.plan.plannedFinish && r.plan.plannedFinish >= start && r.plan.plannedFinish < end) {
        poolCount++;
        if (r.overdue || r.criticalPath) hotCount++;
      }
    }
    week.push({ date, mineCount, poolCount, hotCount });
  }

  return { mine, pool, teamHeld, completed, clearedToday, scoreboard, week, deptMembers, delayCategories };
}
