import { withTenant } from "@/lib/db";
import { assertNotClientUser, hasRole, ROLES, type Actor } from "@/lib/authz";
import { repeatedOpSuffixes } from "@/lib/shared/op-title";
import { sectionize, endOfIstDay, type Sections } from "@/lib/shared/today";
import { istDay, loadMyDay, type MyDayScoreboard } from "./myday.read";
import { routeStepNames } from "./route-step-names";
import { loadFloorUnit, type FloorRow, type FloorUnitView } from "./floor.read";
import type { SheetContext } from "@/components/industrial/floor-actions";

/**
 * Lean Core L2.3: Today. Mine only: the floor steps and operations under the
 * process plans assigned to me (assignment stays plan-grain), plus my own
 * non-derived plans as plan-level rows. Never the department queue: an
 * OPERATOR gets one "Claim next" for the top unassigned plan in their
 * department; a supervisor assigns from the (interim) pool section here until
 * Team (L2.5) takes it.
 *
 * Ranking and the scoreboard are loadMyDay's own (prioritizer, CPM float);
 * row state, refusals and sibling units are the Floor screen's (floor.read),
 * so a row here is ready exactly when the same row is ready on /u/....
 */

export interface TodayRow extends Omit<FloorRow, "kind"> {
  kind: FloorRow["kind"] | "PROCESS_PLAN";
  jobId: number;
  jobNumber: string;
  serialNo: string;
  unitId: number | null;
  /** For Notify; null on plan-level rows. */
  unitPublicId: string | null;
  sheet: SheetContext;
  /** The plan's process name, when this is a step or op under it. */
  stage: string;
}

export interface DoneTodayRow {
  key: string;
  kind: "COMPONENT_OP" | "ASSEMBLY_STEP";
  id: number;
  jobId: number;
  title: string;
  serialNo: string;
  planId: number | null;
}

export interface PoolItem {
  planId: number;
  processName: string;
  jobNumber: string;
  serialNo: string;
  stageLabel: string;
  deptName: string;
  departmentId: number;
  dueAt: string | null;
  overdue: boolean;
}

export interface TodayView {
  sections: Sections<TodayRow>;
  /** Every row of mine, for the end-of-shift list (open ones due today are the plan; the rest are context). */
  checkIn: { open: TodayRow[]; doneToday: DoneTodayRow[] };
  scoreboard: MyDayScoreboard;
  clearedToday: number;
  /** OPERATOR or PLANNER (office pool) only, and only while something is unassigned in their departments. */
  canClaimNext: boolean;
  /** Supervisor and above: the interim "unassigned in my department" section. */
  pool: PoolItem[];
  deptMembers: Record<number, { id: number; name: string }[]>;
  delayCategories: Array<{ id: number; name: string }>;
  canAssign: boolean;
}

const PLAN_STATE: Record<string, FloorRow["state"]> = {
  NOT_STARTED: "READY",
  IN_PROGRESS: "IN_PROGRESS",
  SUBMITTED: "WITH_QC",
  ON_HOLD: "BLOCKED",
};

export async function loadToday(actor: Actor): Promise<TodayView> {
  assertNotClientUser(actor);
  const now = new Date();
  const my = await loadMyDay(actor);

  const minePlans = my.mine.map((m) => m.ranked.plan);
  const myPlanIds = new Set(minePlans.map((p) => p.id));
  const unitIds = [...new Set(minePlans.map((p) => p.unitId).filter((u): u is number => u != null))];
  const views = new Map<number, FloorUnitView>();
  await Promise.all(
    unitIds.map(async (unitId) => {
      const v = await loadFloorUnit(actor, { unitId }, { spine: false });
      if (v) views.set(unitId, v);
    }),
  );

  const rows: TodayRow[] = [];
  const planIdsWithItems = new Set<number>();
  const derived = new Set<number>();
  const stageByPlan = new Map(my.mine.map((m) => [m.ranked.plan.id, m.processName]));
  for (const v of views.values()) {
    for (const id of v.derivedPlanIds) derived.add(id);
    const sheet: SheetContext = {
      jobId: v.unit.jobId,
      serialNo: v.unit.serialNo,
      overrideCategories: v.overrideCategories,
      welders: v.welders,
      lateCategories: v.lateCategories,
    };
    for (const r of v.rows) {
      if (r.planId == null || !myPlanIds.has(r.planId)) continue;
      planIdsWithItems.add(r.planId);
      rows.push({
        ...r,
        jobId: v.unit.jobId,
        jobNumber: v.unit.jobNumber,
        serialNo: v.unit.serialNo,
        unitId: v.unit.id,
        unitPublicId: v.unit.publicId,
        sheet,
        stage: stageByPlan.get(r.planId) ?? r.group,
      });
    }
  }

  // My plans that are recorded directly: not derived from steps / ops, not complete.
  const direct = my.mine.filter(
    (m) => m.ranked.plan.status !== "COMPLETE" && !derived.has(m.ranked.plan.id) && !planIdsWithItems.has(m.ranked.plan.id),
  );
  const reasonsOn = direct.length
    ? await withTenant(actor.tenantId, (tx) =>
        tx.delayReason.findMany({ where: { processPlanId: { in: direct.map((d) => d.ranked.plan.id) } }, select: { processPlanId: true } }),
      )
    : [];
  const hasReason = new Set(reasonsOn.map((r) => r.processPlanId));
  for (const m of direct) {
    const p = m.ranked.plan;
    rows.push({
      key: `PROCESS_PLAN:${p.id}`,
      kind: "PROCESS_PLAN",
      id: p.id,
      title: m.processName,
      group: m.stageLabel,
      state: PLAN_STATE[p.status] ?? "READY",
      startedAt: p.status === "IN_PROGRESS" ? (p.reportedStartAt ?? p.actualStart)?.toISOString() ?? null : null,
      planId: p.id,
      processSeq: null,
      dueAt: p.plannedFinish?.toISOString() ?? null,
      lateReasonNeeded: m.ranked.overdue && !hasReason.has(p.id),
      refusal: null,
      canOverride: false,
      weld: null,
      heatComponentId: null,
      returnedNote: null,
      qty: null, // ponytail: a lot's plan-level count is entered on its unit screen; Today only lists direct plans as one
      siblings: [],
      jobId: m.jobId,
      jobNumber: m.jobNumber,
      serialNo: m.serialNo,
      unitId: p.unitId,
      unitPublicId: null,
      sheet: { jobId: m.jobId, serialNo: m.serialNo, overrideCategories: [], welders: [], lateCategories: my.delayCategories },
      stage: m.processName,
    });
  }

  const sections = sectionize(rows, now);

  // Work I recorded Done today (audit), filled into the check-in as already done.
  const { start } = istDay(now, 0);
  const doneToday = await withTenant(actor.tenantId, async (tx): Promise<DoneTodayRow[]> => {
    const audit = await tx.auditLog.findMany({
      where: {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "work.done",
        entityType: { in: ["AssemblyStep", "ComponentOperation"] },
        at: { gte: start },
      },
      select: { entityType: true, entityId: true },
    });
    const stepIds = audit.filter((a) => a.entityType === "AssemblyStep").map((a) => Number(a.entityId));
    const opIds = audit.filter((a) => a.entityType === "ComponentOperation").map((a) => Number(a.entityId));
    const [steps, ops] = await Promise.all([
      stepIds.length
        ? tx.assemblyStep.findMany({
            where: { id: { in: stepIds } },
            select: { id: true, jobId: true, templateStep: { select: { activity: true } }, unit: { select: { serialNo: true } } },
          })
        : Promise.resolve([]),
      opIds.length
        ? tx.componentOperation.findMany({
            where: { id: { in: opIds } },
            select: {
              id: true,
              jobId: true,
              componentId: true,
              operation: { select: { name: true } },
              component: { select: { unit: { select: { serialNo: true } } } },
            },
          })
        : Promise.resolve([]),
    ]);
    // A repeated operation on a route (a head's Forming twice) is numbered: that needs the part's other steps.
    const siblings = ops.length
      ? await tx.componentOperation.findMany({
          where: { componentId: { in: [...new Set(ops.map((o) => o.componentId))] } },
          select: { id: true, componentId: true, seq: true, operation: { select: { name: true } }, component: { select: { routeVersionId: true } } },
        })
      : [];
    const printed = await routeStepNames(tx, siblings.map((o) => ({ id: o.id, seq: o.seq, routeVersionId: o.component.routeVersionId })));
    const repeats = repeatedOpSuffixes(siblings.map((o) => ({ key: o.id, group: o.componentId, name: o.operation.name, seq: o.seq, printed: printed.get(o.id) })));
    return [
      ...steps.map((s) => ({
        key: `ASSEMBLY_STEP:${s.id}`,
        kind: "ASSEMBLY_STEP" as const,
        id: s.id,
        jobId: s.jobId,
        title: s.templateStep.activity,
        serialNo: s.unit.serialNo,
        planId: null,
      })),
      ...ops.map((o) => ({
        key: `COMPONENT_OP:${o.id}`,
        kind: "COMPONENT_OP" as const,
        id: o.id,
        jobId: o.jobId,
        title: `${o.operation.name}${repeats.get(o.id) ?? ""}`,
        serialNo: o.component.unit?.serialNo ?? "—",
        planId: null,
      })),
    ];
  });

  const canAssign = hasRole(actor, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  const operator = hasRole(actor, ROLES.OPERATOR, ROLES.PLANNER) && !canAssign;
  const poolRows = my.pool.filter((p) => p.ranked.state !== "DONE");
  const eod = endOfIstDay(now);
  const open = [...(sections.doFirst ? [sections.doFirst] : []), ...sections.today].filter(
    (r) => r.state === "IN_PROGRESS" || (r.dueAt != null && new Date(r.dueAt) <= eod) || r.lateReasonNeeded,
  );

  return {
    sections,
    checkIn: { open, doneToday },
    scoreboard: my.scoreboard,
    clearedToday: my.clearedToday,
    canClaimNext: operator && poolRows.length > 0,
    pool: canAssign
      ? poolRows.map((p) => ({
          planId: p.ranked.plan.id,
          processName: p.processName,
          jobNumber: p.jobNumber,
          serialNo: p.serialNo,
          stageLabel: p.stageLabel,
          deptName: p.deptName,
          departmentId: p.ranked.plan.ownerDepartmentId,
          dueAt: p.ranked.plan.plannedFinish?.toISOString() ?? null,
          overdue: p.ranked.overdue,
        }))
      : [],
    deptMembers: my.deptMembers,
    delayCategories: my.delayCategories,
    canAssign,
  };
}
