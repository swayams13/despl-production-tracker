import { withTenant } from "@/lib/db";
import { assertNotClientUser, hasRole, ROLES, type Actor } from "@/lib/authz";
import { sameDayRate, summarizeTeam, type TeamPlanFact, type PersonLoad } from "@/lib/shared/team";
import { loadCommandCenter, resolveCommandCenterAccess, type CommandCenterAccess, type CommandCenterRow } from "./command-center.read";
import { loadWeldingView, type WelderCard } from "./welding.read";

/**
 * Lean Core L2.5: Team, the supervisor's crew and the Production Head's
 * department view. The department cockpit rows, roster and dependencies are
 * loadCommandCenter's (it is department-generic: only its page was
 * office-only); this adds what a crew supervisor asks of it: workload by
 * person, the unassigned pool, who owes a reason, what went out of order, the
 * same-day update rate, and welder output. A move plus five thin reads, per
 * audit/05 §8.
 */

export interface TeamRow {
  planId: number;
  jobId: number;
  jobNumber: string;
  processName: string;
  serialNo: string;
  stageLabel: string;
  assigneeId: number | null;
  assigneeName: string | null;
  state: string;
  dueAt: string | null;
  overdue: boolean;
  daysLate: number | null;
  /** Overdue / blocked rows: has a delay reason been filed on the plan? */
  reason: { filed: boolean; category: string | null };
  /** BLOCKED rows: the prioritizer's "Waiting on: …" text. */
  waitingOn: string | null;
}

export interface TeamView {
  department: { id: number; code: string; name: string; supervisors: string[] };
  access: CommandCenterAccess;
  departments: Array<{ id: number; code: string; name: string }>;
  kpi: {
    open: number;
    assigned: number;
    unassigned: number;
    overdue: number;
    blocked: number;
    onTimePct: number | null;
    sameDayPct: number | null;
    sameDayTotal: number;
    clearedToday: number;
    openRework: number;
  };
  people: Array<PersonLoad & { items: TeamRow[] }>;
  pool: TeamRow[];
  overdueBlocked: TeamRow[];
  blocking: TeamRow[];
  waitingOnOthers: TeamRow[];
  outOfSequence: Array<{ id: number; title: string; serialNo: string; jobNumber: string; category: string; note: string | null; by: string; at: string }>;
  byProcess: Array<{ processName: string; open: number; overdueIds: number[] }>;
  welders: WelderCard[];
  jobs: Array<{ id: number; jobNumber: string }>;
  delayCategories: Array<{ id: number; name: string }>;
}

const DAY = 24 * 3600 * 1000;

/** Access to a department's Team: members, Production Head and Admin act; Management reads; others get nothing. */
export { resolveCommandCenterAccess as resolveTeamAccess };

export async function loadTeam(
  actor: Actor,
  department: { id: number; code: string; name: string },
): Promise<TeamView | null> {
  assertNotClientUser(actor);
  const access = resolveCommandCenterAccess(actor, department.id);
  if (access === "none") return null;

  const now = new Date();
  const cc = await loadCommandCenter(actor, department.id, department.code, department.name);
  const rows = cc.pipeline.flatMap((c) => c.rows).filter((r) => r.ranked.state !== "DONE");

  const supervisors = await withTenant(actor.tenantId, async (tx) => {
    const sup = await tx.userDepartment.findMany({
      where: { departmentId: department.id, user: { active: true, clientId: null, roles: { some: { role: { code: ROLES.SUPERVISOR } } } } },
      select: { user: { select: { name: true } } },
    });
    return sup.map((s) => s.user.name);
  });

  const nameById = new Map(cc.team.map((m) => [m.userId, m.name]));
  const extra = await withTenant(actor.tenantId, async (tx) => {
    const needReason = rows.filter((r) => r.ranked.overdue || r.ranked.state === "BLOCKED").map((r) => r.ranked.plan.id);
    const assigneeIds = [...new Set(rows.map((r) => r.ranked.plan.assigneeUserId).filter((x): x is number => x != null))].filter(
      (x) => !nameById.has(x),
    );

    const since = new Date(now.getTime() - 7 * DAY);
    const [reasons, outsiders, departments, events, overrides, delayCategories] = await Promise.all([
      needReason.length
        ? tx.delayReason.findMany({
            where: { processPlanId: { in: needReason } },
            orderBy: { filedAt: "desc" },
            select: { processPlanId: true, category: { select: { name: true } } },
          })
        : Promise.resolve([]),
      assigneeIds.length ? tx.user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      tx.department.findMany({ where: { tenantId: actor.tenantId }, orderBy: [{ isOfficeDept: "asc" }, { name: "asc" }], select: { id: true, code: true, name: true } }),
      Promise.all([
        tx.assemblyStep.findMany({
          where: { templateStep: { defaultDepartmentId: department.id }, OR: [{ startedAt: { gte: since } }, { finishedAt: { gte: since } }] },
          select: { startedAt: true, reportedStartAt: true, finishedAt: true, reportedFinishAt: true },
        }),
        tx.componentOperation.findMany({
          where: { operation: { defaultDepartmentId: department.id }, OR: [{ startedAt: { gte: since } }, { finishedAt: { gte: since } }] },
          select: { startedAt: true, reportedStartAt: true, finishedAt: true, reportedFinishAt: true },
        }),
      ]),
      tx.sequenceOverride.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          targetKind: true,
          targetId: true,
          category: true,
          note: true,
          createdAt: true,
          creator: { select: { name: true } },
          unit: { select: { serialNo: true } },
          job: { select: { jobNumber: true } },
        },
      }),
      tx.delayCategoryRef.findMany({ where: { tenantId: actor.tenantId, active: true }, orderBy: { id: "asc" }, select: { id: true, name: true } }),
    ]);

    // Overrides on this department's items only: resolve each target's department.
    const stepIds = overrides.filter((o) => o.targetKind === "ASSEMBLY_STEP").map((o) => o.targetId);
    const opIds = overrides.filter((o) => o.targetKind === "COMPONENT_OP").map((o) => o.targetId);
    const [steps, ops] = await Promise.all([
      stepIds.length
        ? tx.assemblyStep.findMany({
            where: { id: { in: stepIds }, templateStep: { defaultDepartmentId: department.id } },
            select: { id: true, templateStep: { select: { activity: true } } },
          })
        : Promise.resolve([]),
      opIds.length
        ? tx.componentOperation.findMany({
            where: { id: { in: opIds }, operation: { defaultDepartmentId: department.id } },
            select: { id: true, operation: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);
    const stepTitle = new Map(steps.map((s) => [s.id, s.templateStep.activity]));
    const opTitle = new Map(ops.map((o) => [o.id, o.operation.name]));
    return { reasons, outsiders, departments, events, overrides, stepTitle, opTitle, delayCategories };
  });

  for (const u of extra.outsiders) nameById.set(u.id, u.name);
  const reasonByPlan = new Map<number, string>();
  for (const r of extra.reasons) if (!reasonByPlan.has(r.processPlanId)) reasonByPlan.set(r.processPlanId, r.category.name);

  const toRow = (r: CommandCenterRow): TeamRow => {
    const p = r.ranked.plan;
    const late = r.ranked.overdue && p.plannedFinish ? Math.max(1, Math.ceil((now.getTime() - p.plannedFinish.getTime()) / DAY)) : null;
    return {
      planId: p.id,
      jobId: r.jobId,
      jobNumber: r.jobNumber,
      processName: r.processName,
      serialNo: r.serialNo,
      stageLabel: r.stageLabel,
      assigneeId: p.assigneeUserId,
      assigneeName: p.assigneeUserId != null ? (nameById.get(p.assigneeUserId) ?? null) : null,
      state: r.ranked.state,
      dueAt: p.plannedFinish?.toISOString() ?? null,
      overdue: r.ranked.overdue,
      daysLate: late,
      reason: { filed: reasonByPlan.has(p.id), category: reasonByPlan.get(p.id) ?? null },
      waitingOn: r.ranked.state === "BLOCKED" ? r.ranked.reasonText : null,
    };
  };

  const teamRows = rows.map(toRow);
  const facts: TeamPlanFact[] = rows.map((r) => ({
    planId: r.ranked.plan.id,
    assigneeId: r.ranked.plan.assigneeUserId,
    state: r.ranked.state,
    overdue: r.ranked.overdue,
    dueAt: r.ranked.plan.plannedFinish?.toISOString() ?? null,
  }));
  const summary = summarizeTeam(facts, cc.team.map((m) => ({ userId: m.userId, name: m.name })), now);

  const rowsOf = (userId: number) => teamRows.filter((r) => r.assigneeId === userId);
  const people = summary.people.map((p) => ({ ...p, items: rowsOf(p.userId) }));

  // Same-day updates: each recorded start / finish stamp is one event.
  const since = new Date(now.getTime() - 7 * DAY);
  const events = extra.events.flat().flatMap((e) => [
    ...(e.startedAt && e.startedAt >= since ? [{ recordedAt: e.startedAt, reportedAt: e.reportedStartAt }] : []),
    ...(e.finishedAt && e.finishedAt >= since ? [{ recordedAt: e.finishedAt, reportedAt: e.reportedFinishAt }] : []),
  ]);
  const same = sameDayRate(events);

  const byProcess = new Map<string, { open: number; overdueIds: number[] }>();
  for (const r of teamRows) {
    const g = byProcess.get(r.processName) ?? { open: 0, overdueIds: [] };
    g.open++;
    if (r.overdue && !r.reason.filed) g.overdueIds.push(r.planId);
    byProcess.set(r.processName, g);
  }

  // Welder output: only departments that have welders on their register.
  let welders: WelderCard[] = [];
  if (hasRole(actor, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN, ROLES.MANAGEMENT)) {
    const wv = await loadWeldingView(actor);
    const mine = new Set(wv.welderRegistry.filter((w) => w.departmentId === department.id && w.active).map((w) => w.id));
    welders = wv.welders.filter((w) => mine.has(w.welderId));
  }

  const outOfSequence = extra.overrides
    .filter((o) => (o.targetKind === "ASSEMBLY_STEP" ? extra.stepTitle.has(o.targetId) : o.targetKind === "COMPONENT_OP" && extra.opTitle.has(o.targetId)))
    .map((o) => ({
      id: o.id,
      title: (o.targetKind === "ASSEMBLY_STEP" ? extra.stepTitle.get(o.targetId) : extra.opTitle.get(o.targetId)) ?? "",
      serialNo: o.unit?.serialNo ?? "—",
      jobNumber: o.job.jobNumber,
      category: o.category,
      note: o.note,
      by: o.creator.name,
      at: o.createdAt.toISOString(),
    }));

  return {
    department: { ...department, supervisors },
    access,
    departments: extra.departments,
    kpi: {
      open: summary.open,
      assigned: summary.assigned,
      unassigned: summary.unassigned,
      overdue: summary.overdue,
      blocked: summary.blocked,
      onTimePct: cc.kpi.onTimePct,
      sameDayPct: same.rate,
      sameDayTotal: same.total,
      clearedToday: cc.clearedToday,
      openRework: cc.kpi.openReworkCount,
    },
    people,
    pool: teamRows.filter((r) => r.assigneeId == null).sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9")),
    overdueBlocked: teamRows
      .filter((r) => r.overdue || r.state === "BLOCKED")
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (b.daysLate ?? 0) - (a.daysLate ?? 0)),
    blocking: cc.blocking.map(toRow),
    waitingOnOthers: cc.waitingOnOthers.map(toRow),
    outOfSequence,
    byProcess: [...byProcess].map(([processName, g]) => ({ processName, ...g })).sort((a, b) => b.overdueIds.length - a.overdueIds.length || b.open - a.open),
    welders,
    jobs: [...new Map(teamRows.map((r) => [r.jobId, { id: r.jobId, jobNumber: r.jobNumber }])).values()],
    delayCategories: extra.delayCategories,
  };
}
