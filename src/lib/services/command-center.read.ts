import { withTenant } from "@/lib/db";
import { hasRole, ROLES, type Actor } from "@/lib/authz";
import { computeCpm } from "@/lib/schedule";
import { getCurrentScheduleRunsBatch, loadJobSpinesBatch } from "./_shared";
import { prioritize, compareRankedPlans, type RankedPlan, type PlanState } from "./prioritizer";
import { loadJobs } from "./jobs.read";
import { stageLabel } from "./workspace.read";
import { loadDepartmentCards, type DeptCard } from "./departments.read";
import { istDay } from "./myday.read";

/**
 * `/command/[dept]` (personal dashboards v1, SPEC §7.4) — the desk-side
 * counterpart to `/my-day`/`/workspace` for a tenant's OFFICE departments
 * (`Department.isOfficeDept`; DESPL's own 6 today are PROJECTS, ENGINEERING,
 * PLANNING, PROCUREMENT, QC, STORES — task 3.1 ruling 1: "PMO" in the spec
 * text is this seed's PROJECTS code). Floor departments never reach this
 * reader — `/command/[dept]/page.tsx` redirects them to `/workspace` before
 * calling in.
 *
 * Cross-job aggregation follows myday.read.ts's precedent verbatim (ruling
 * 2a): loop the tenant's ACTIVE jobs, run the existing spine → CPM →
 * `prioritize()` pipeline unchanged per job, merge. Unlike `/my-day` this
 * view has no "actor" partition — it's one department's board — but the
 * "You're blocking" section (ruling 2f) needs EVERY department's ranked
 * plans per job (to see who else's BLOCKED items name one of this dept's
 * processes as a blocker), not just this department's own slice.
 *
 * ponytail: same N-active-jobs-worth-of-queries tradeoff myday.read.ts
 * already flags (spine + CPM + prioritize per active job) — fine at DESPL's
 * pilot scale, revisit together if that ever needs batching.
 */

/**
 * Pipeline column labels (task 3.1 ruling 2c / SPEC §7.4 "dept pipeline"):
 * cosmetic relabeling of the same 6 `PlanState` values into each office
 * department's own entry-surface vocabulary (BUILD-SPEC-v2 §3). NOT a new
 * taxonomy and NOT per-process — v1 renders from ProcessPlan-grain data
 * only, so every dept still has exactly these 6 buckets, just worded in its
 * own language. One file, easy for DESPL to correct later (same pattern as
 * decision #6, "drafted by us, corrected by DESPL").
 *
 * Deliberately still keyed by DESPL's 6 known department codes (not
 * data-driven) — copywriting authored per department, not a lookup/routing
 * decision like the office/floor split `Department.isOfficeDept` now owns.
 * A department with no entry here falls back to `DEFAULT_PIPELINE_LABELS`
 * (see `loadCommandCenter`) rather than crashing.
 */
export const PIPELINE_LABELS: Record<string, Record<PlanState, string>> = {
  PROJECTS: {
    BLOCKED: "Waiting on prior step",
    READY: "Ready for PO review",
    IN_PROGRESS: "Kick-off in progress",
    SUBMITTED: "Submitted for sign-off",
    ON_HOLD: "On hold",
    DONE: "Kick-off complete",
  },
  ENGINEERING: {
    BLOCKED: "Waiting on inputs",
    READY: "Ready for design calc",
    IN_PROGRESS: "Drawing in progress",
    SUBMITTED: "Awaiting client approval",
    ON_HOLD: "On hold",
    DONE: "Drawing approved",
  },
  PLANNING: {
    BLOCKED: "Waiting on drawings",
    READY: "Ready for BOM & MTO",
    IN_PROGRESS: "Cutting plan in progress",
    SUBMITTED: "Submitted for review",
    ON_HOLD: "On hold",
    DONE: "Plan released",
  },
  PROCUREMENT: {
    BLOCKED: "Waiting on indent",
    READY: "Ready to raise PO",
    IN_PROGRESS: "With vendor",
    SUBMITTED: "Awaiting delivery confirmation",
    ON_HOLD: "On hold",
    DONE: "Delivered",
  },
  QC: {
    BLOCKED: "Waiting on inspection call",
    READY: "Ready for QCP checkpoint",
    IN_PROGRESS: "Inspection in progress",
    SUBMITTED: "Awaiting verification",
    ON_HOLD: "Hold point open",
    DONE: "Cleared",
  },
  STORES: {
    BLOCKED: "Waiting on PO",
    READY: "Ready to receive",
    IN_PROGRESS: "Partial receipt",
    SUBMITTED: "GRN submitted",
    ON_HOLD: "On hold",
    DONE: "GRN complete",
  },
};

/** Generic English fallback for an office department with no entry in
 * `PIPELINE_LABELS` yet — a new office department is data (an
 * `isOfficeDept: true` row), so it must render something sensible before
 * anyone gets around to writing it its own copy. */
const DEFAULT_PIPELINE_LABELS: Record<PlanState, string> = {
  BLOCKED: "Blocked",
  READY: "Ready",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  ON_HOLD: "On hold",
  DONE: "Done",
};

const PIPELINE_ORDER: PlanState[] = ["BLOCKED", "READY", "IN_PROGRESS", "SUBMITTED", "ON_HOLD", "DONE"];

/**
 * Which real department a `/command/[dept]` URL slug names (task 3.1 ruling
 * 1 — office departments render, floor departments redirect to /workspace,
 * anything that isn't a real department in this tenant is `notFound()`).
 * Pulled out as a pure function over the caller's own department lookup
 * (no DB access here, no hardcoded department-code list) so the routing
 * rule stays table-driven-testable without a page-render harness, which
 * this codebase doesn't have. `Department.isOfficeDept` is the real
 * source of truth — see the migration that added it.
 */
export function classifyDeptCode(department: { isOfficeDept: boolean } | null): "office" | "floor" | "invalid" {
  if (!department) return "invalid";
  return department.isOfficeDept ? "office" : "floor";
}

export type CommandCenterAccess = "full" | "readonly" | "none";

/**
 * Task 3.1 ruling 3: dept members + PH/ADMIN get full read+action access;
 * MANAGEMENT gets read-only (page renders, zero action buttons); anyone
 * else — wrong department, no relevant role — gets no access at all
 * (`notFound()` at the call site, same refusal shape as an invalid id).
 * Pulled out as a pure function so the rule is table-driven-testable without
 * a DB or a page-render harness.
 */
export function resolveCommandCenterAccess(actor: Actor, departmentId: number): CommandCenterAccess {
  const isMember = actor.departmentIds.includes(departmentId);
  if (isMember || hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN)) return "full";
  if (hasRole(actor, ROLES.MANAGEMENT)) return "readonly";
  return "none";
}

/** A ranked plan with the display fields the page needs — same
 * denormalize-in-the-read-function convention as myday.read.ts's MyDayRow. */
export interface CommandCenterRow {
  ranked: RankedPlan;
  jobId: number;
  jobNumber: string;
  processName: string;
  serialNo: string;
  stageLabel: string;
  stageNo: number;
  /** The row's OWNING department name — this dept's own name for
   * decideToday/pipeline/waitingOnOthers rows; the OTHER department's name
   * for "You're blocking" rows (whose plan actually belongs to them). */
  deptName: string;
}

export interface CommandCenterWeekDay {
  /** IST calendar day, "YYYY-MM-DD". */
  date: string;
  /** This department's open plans due that day (analogous to myday.read.ts's
   * mineCount+poolCount, collapsed to one number — Command Center has no
   * per-actor partition). */
  loadCount: number;
  /** Of that day's load, how many are overdue or on the critical path. */
  hotCount: number;
}

export interface CommandCenterPipelineColumn {
  state: PlanState;
  label: string;
  rows: CommandCenterRow[];
}

export interface CommandCenterView {
  deptId: number;
  deptCode: string;
  deptName: string;
  /** Dept items COMPLETE or SUBMITTED today (server date), any assignee —
   * dept-wide version of myday.read.ts's clearedToday. */
  clearedToday: number;
  /** Top-5 of this dept's ranked items, prioritizer order, viewer's own
   * items first among ties (ruling 2d). */
  decideToday: CommandCenterRow[];
  week: CommandCenterWeekDay[];
  pipeline: CommandCenterPipelineColumn[];
  /** Other departments' BLOCKED plans whose blocking predecessor(s) belong
   * to this department (ruling 2f) — `deptName` on each row names the
   * OTHER (blocked) department. */
  blocking: CommandCenterRow[];
  /** This dept's own BLOCKED plans (ruling 2e) — `ranked.reasonText` already
   * reads "Waiting on: X, Y." */
  waitingOnOthers: CommandCenterRow[];
  /** SPEC §6.3 SQL-view rule: the exact row `/departments` already computes
   * for this dept via `loadDepartmentCards` — never recomputed here. */
  kpi: DeptCard;
}

export async function loadCommandCenter(
  actor: Actor,
  deptId: number,
  deptCode: string,
  deptName: string,
): Promise<CommandCenterView> {
  const now = new Date();
  const jobs = (await loadJobs(actor)).filter((j) => j.status === "ACTIVE");

  const ownRows: CommandCenterRow[] = [];
  const blockingRows: CommandCenterRow[] = [];
  const activeRunIds: number[] = [];

  const { clearedToday } = await withTenant(actor.tenantId, async (tx) => {
    const departments = await tx.department.findMany({ select: { id: true, name: true } });
    const deptNameById = new Map(departments.map((d) => [d.id, d.name]));

    const jobIds = jobs.map((j) => j.id);
    const [runsByJob, spinesByJob] = await Promise.all([
      getCurrentScheduleRunsBatch(tx, jobIds, null),
      loadJobSpinesBatch(tx, jobIds),
    ]);
    const allUnits = await tx.unit.findMany({
      where: { equipment: { jobId: { in: jobIds } } },
      select: { id: true, serialNo: true, equipment: { select: { jobId: true } } },
    });
    const unitsByJob = new Map<number, typeof allUnits>();
    for (const u of allUnits) {
      const bucket = unitsByJob.get(u.equipment.jobId);
      if (bucket) bucket.push(u);
      else unitsByJob.set(u.equipment.jobId, [u]);
    }

    for (const job of jobs) {
      const run = runsByJob.get(job.id);
      if (!run) continue;
      activeRunIds.push(run.id);

      const spine = spinesByJob.get(job.id);
      if (!spine) continue;
      const cpm = computeCpm(spine.processes, spine.edges);
      const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
      const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));
      const procMeta = new Map(
        spine.rawProcesses.map((p) => [p.id, { name: p.name, stageLabel: stageLabel(p.workOrderStages), stageNo: p.workOrderStages[0] ?? 0 }]),
      );
      const units = unitsByJob.get(job.id) ?? [];
      const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));

      const rankedByDept = prioritize({
        plans: run.processPlans,
        edges: spine.edges,
        floatByProcessId,
        processNameById,
        today: now,
      });

      const toRow = (r: RankedPlan, ownerDeptId: number): CommandCenterRow => {
        const meta = procMeta.get(r.plan.jobProcessId);
        return {
          ranked: r,
          jobId: job.id,
          jobNumber: job.jobNumber,
          processName: meta?.name ?? processNameById.get(r.plan.jobProcessId) ?? `#${r.plan.jobProcessId}`,
          serialNo: r.plan.unitId != null ? (serialByUnit.get(r.plan.unitId) ?? `#${r.plan.unitId}`) : "—",
          stageLabel: meta?.stageLabel ?? "—",
          stageNo: meta?.stageNo ?? 0,
          deptName: deptNameById.get(ownerDeptId) ?? `#${ownerDeptId}`,
        };
      };

      // This department's own plans, every state — the source for
      // decideToday/pipeline/waitingOnOthers below.
      for (const r of rankedByDept.get(deptId) ?? []) {
        ownRows.push(toRow(r, deptId));
      }

      // "You're blocking" (ruling 2f): other departments' BLOCKED plans whose
      // blockingPredecessorIds name a jobProcess owned by THIS department. A
      // jobProcessId's owning department is static (JobProcess.departmentId),
      // so a simple set-membership check covers every unit without a
      // per-unit join.
      const deptProcessIds = new Set(spine.rawProcesses.filter((p) => p.departmentId === deptId).map((p) => p.id));
      if (deptProcessIds.size > 0) {
        for (const [otherDeptId, rows] of rankedByDept) {
          if (otherDeptId === deptId) continue;
          for (const r of rows) {
            if (r.state !== "BLOCKED") continue;
            if (r.blockingPredecessorIds.some((id) => deptProcessIds.has(id))) {
              blockingRows.push(toRow(r, otherDeptId));
            }
          }
        }
      }
    }

    // clearedToday — dept-wide (every assignee), same event-sourced
    // COMPLETE+SUBMITTED-today pattern myday.read.ts uses, scoped to
    // ownerDepartmentId instead of assigneeUserId.
    const { start: todayStart, end: todayEnd } = istDay(now, 0);
    const completedTodayCount = activeRunIds.length
      ? await tx.processPlan.count({
          where: {
            ownerDepartmentId: deptId,
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
          WHERE pp.owner_department_id = ${deptId}
            AND pp.status = 'SUBMITTED'
            AND pp.schedule_run_id = ANY(${activeRunIds}::int[])
            AND de.type = 'ProcessSubmitted'
            AND de.at >= ${todayStart} AND de.at < ${todayEnd}
        `
      : [];
    return { clearedToday: completedTodayCount + (submittedTodayRows[0]?.n ?? 0) };
  });

  // decideToday (ruling 2d): top-5, prioritizer order, viewer's own items
  // first among ties — a stable secondary sort key on top of the
  // prioritizer's own comparator, not a change to it.
  const actionable = ownRows.filter((r) => r.ranked.state !== "DONE");
  actionable.sort((a, b) => {
    const c = compareRankedPlans(a.ranked, b.ranked);
    if (c !== 0) return c;
    const aMine = a.ranked.plan.assigneeUserId === actor.userId ? 0 : 1;
    const bMine = b.ranked.plan.assigneeUserId === actor.userId ? 0 : 1;
    return aMine - bMine;
  });
  const decideToday = actionable.slice(0, 5);

  // waitingOnOthers (ruling 2e): this dept's own BLOCKED plans, reasonText
  // already ready-to-render.
  const waitingOnOthers = ownRows.filter((r) => r.ranked.state === "BLOCKED").sort((a, b) => compareRankedPlans(a.ranked, b.ranked));

  // pipeline (ruling 2c): group by state in a fixed display order. DONE is
  // capped to the last 7 days (same rolling window myday.read.ts's
  // doneThisWeek uses) — an unbounded "everything ever completed" column
  // would grow forever and isn't what "pipeline" means for a live cockpit.
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const labels = PIPELINE_LABELS[deptCode] ?? DEFAULT_PIPELINE_LABELS;
  const pipeline: CommandCenterPipelineColumn[] = PIPELINE_ORDER.map((state) => {
    let rows = ownRows.filter((r) => r.ranked.state === state);
    if (state === "DONE") {
      rows = rows.filter((r) => r.ranked.plan.actualFinish != null && r.ranked.plan.actualFinish >= sevenDaysAgo);
    }
    rows = [...rows].sort((a, b) => compareRankedPlans(a.ranked, b.ranked));
    return { state, label: labels[state], rows };
  });

  blockingRows.sort((a, b) => compareRankedPlans(a.ranked, b.ranked));

  // week (ruling: "same shape/spirit as myday.read.ts's week field ... but
  // scoped to the whole department instead of one actor") — T+0..T+5 load
  // over this dept's non-DONE plans, bucketed by plannedFinish.
  const week: CommandCenterWeekDay[] = [];
  for (let offset = 0; offset <= 5; offset++) {
    const { start, end, date } = istDay(now, offset);
    let loadCount = 0;
    let hotCount = 0;
    for (const r of actionable) {
      const pf = r.ranked.plan.plannedFinish;
      if (pf && pf >= start && pf < end) {
        loadCount++;
        if (r.ranked.overdue || r.ranked.criticalPath) hotCount++;
      }
    }
    week.push({ date, loadCount, hotCount });
  }

  // kpi (ruling 2b / SPEC §6.3 SQL-view rule): the exact row /departments
  // already computes for this dept — never recomputed here.
  const kpi = (await loadDepartmentCards(actor)).find((d) => d.id === deptId);
  if (!kpi) throw new Error(`loadDepartmentCards returned no row for department ${deptId}`);

  return { deptId, deptCode, deptName, clearedToday, decideToday, week, pipeline, blocking: blockingRows, waitingOnOthers, kpi };
}
