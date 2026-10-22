import { withTenant } from "@/lib/db";
import { assertClientScope, assertNotClientUser, type Actor } from "@/lib/authz";
import { deriveCell, type BoardStatus, type CellView } from "@/lib/shared/board";
import { loadJobHeader, type JobHeader } from "./job-detail.read";
import { loadJobSpines } from "./spine.read";
import { loadOpSeqResolver, loadWorkOrderStageNames, workOrderStageName } from "./_shared";
import { inRoute, loadJobRoutes } from "./line-route";
import { activeRow } from "./active-row";

/**
 * Lean Core L2.4: the Job board. One row per unit, one column per work-order
 * stage of the job's own template (an exchanger shows its own), every cell a
 * printed value (board.ts deriveCell). Status, overdue and rejected come from
 * the canonical `v_unit_stage_status` view through loadJobSpines (never
 * re-derived here); the values come from the backing plans and the mapped
 * steps / operations. Read-only: the sheet's writes are recordWork's / inspect's.
 */

export interface BoardStage {
  stageNo: number;
  name: string;
  departmentId: number | null;
  departmentName: string | null;
  /** Units complete at this stage, over units that have a process there. */
  done: number;
  total: number;
}

export interface BoardCell extends CellView {
  stageNo: number;
  governingPlanId: number | null;
}

export interface BoardUnit {
  unitId: number;
  publicId: string;
  serialNo: string;
  /** First stage not yet complete; null = every stage done. */
  currentStage: { stageNo: number; name: string } | null;
  cells: Record<number, BoardCell>;
}

/** One line (route) of a job that has more than one: its own stage names, over its own units. */
export interface BoardLine {
  name: string;
  stages: BoardStage[];
  unitIds: number[];
}

export interface BoardView {
  header: JobHeader;
  stages: BoardStage[];
  units: BoardUnit[];
  /** Present only when the job has more than one route (J3b); a single-route job has none. */
  lines?: BoardLine[];
  departments: Array<{ id: number; name: string }>;
  counts: { openHolds: number; overdue: number; outOfSequence: number };
}

const DAY = 24 * 3600 * 1000;

export async function loadJobBoard(actor: Actor, jobId: number): Promise<BoardView | null> {
  assertNotClientUser(actor);
  const header = await loadJobHeader(actor, jobId);
  if (!header) return null;
  const spines = await loadJobSpines(actor, jobId);
  if (!spines) return null;

  const data = await withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true, familyId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const processes = await tx.jobProcess.findMany({
      where: { jobId, included: true },
      orderBy: { seq: "asc" },
      select: { id: true, seq: true, equipmentId: true, grain: true, workOrderStages: true, departmentId: true, department: { select: { name: true } } },
    });
    const run = await tx.scheduleRun.findFirst({ where: { jobId, equipmentId: null, isCurrent: true }, select: { id: true } });
    const [plans, steps, ops, overrides, resolve, units] = await Promise.all([
      run
        ? tx.processPlan.findMany({
            where: { scheduleRunId: run.id },
            select: { id: true, jobProcessId: true, unitId: true, status: true, plannedFinish: true, actualFinish: true },
          })
        : Promise.resolve([]),
      tx.assemblyStep.findMany({
        where: { ...activeRow, jobId },
        select: { id: true, unitId: true, status: true, templateStep: { select: { leadTimeProcessSeq: true } } },
      }),
      tx.componentOperation.findMany({
        where: { ...activeRow, jobId },
        select: { id: true, status: true, seq: true, operationId: true, component: { select: { unitId: true, routeVersionId: true } } },
      }),
      tx.sequenceOverride.findMany({ where: { jobId }, select: { targetKind: true, targetId: true, unitId: true } }),
      loadOpSeqResolver(tx, job.familyId),
      tx.unit.findMany({ where: { jobId }, select: { id: true, publicId: true } }),
    ]);
    const { routes, keyOfUnit } = await loadJobRoutes(tx, jobId);
    const namesOf = new Map(
      await Promise.all(routes.map(async (r) => [r.key, await loadWorkOrderStageNames(tx, actor.tenantId, r.familyId)] as const)),
    );
    return { processes, plans, steps, ops, overrides, resolve, units, routes, keyOfUnit, namesOf };
  });
  if (!data) return null;

  const { processes, plans, steps, ops, overrides, resolve, routes, keyOfUnit, namesOf } = data;
  const publicIdOf = new Map(data.units.map((u) => [u.id, u.publicId]));
  const now = Date.now();

  // stage -> backing processes; process seq -> stages
  const stageNos = [...new Set(spines.flatMap((u) => u.segments.map((s) => s.stageNo)))].sort((a, b) => a - b);
  // J3b: both lookups are per route, so a line's unit only ever sees its own route's processes.
  const backingOf = new Map<number | null, Map<number, typeof processes>>();
  const stagesOfSeqOf = new Map<number | null, Map<number, number[]>>();
  for (const r of routes) {
    const backing = new Map<number, typeof processes>();
    const stagesOfSeq = new Map<number, number[]>();
    for (const p of processes.filter((p) => inRoute(p, r.key))) {
      stagesOfSeq.set(p.seq, p.workOrderStages);
      for (const s of p.workOrderStages) backing.set(s, [...(backing.get(s) ?? []), p]);
    }
    backingOf.set(r.key, backing);
    stagesOfSeqOf.set(r.key, stagesOfSeq);
  }
  const stagesOfSeq = (unitId: number, seq: number) => stagesOfSeqOf.get(keyOfUnit.get(unitId) ?? null)?.get(seq) ?? [];

  const planAt = new Map(plans.map((p) => [`${p.jobProcessId}:${p.unitId ?? "job"}`, p]));
  const seqOfProcess = new Map(processes.map((p) => [p.id, p.seq]));
  const planById = new Map(plans.map((p) => [p.id, p]));

  // item counts per `${unitId}:${stageNo}`
  const itemCount = new Map<string, { done: number; total: number }>();
  const bump = (unitId: number | null, seq: number | null, status: string) => {
    if (unitId == null || seq == null) return;
    for (const stage of stagesOfSeq(unitId, seq)) {
      const k = `${unitId}:${stage}`;
      const c = itemCount.get(k) ?? { done: 0, total: 0 };
      c.total++;
      if (status === "COMPLETE" || status === "SUBMITTED") c.done++;
      itemCount.set(k, c);
    }
  };
  const stepSeq = new Map<number, number | null>();
  for (const s of steps) {
    stepSeq.set(s.id, s.templateStep.leadTimeProcessSeq);
    bump(s.unitId, s.templateStep.leadTimeProcessSeq, s.status);
  }
  const opSeq = new Map<number, number | null>();
  for (const o of ops) {
    const seq = resolve({ operationId: o.operationId, seq: o.seq, routeVersionId: o.component.routeVersionId });
    opSeq.set(o.id, seq);
    bump(o.component.unitId, seq, o.status);
  }

  // out-of-sequence per `${unitId}:${stageNo}`, and distinct overridden items
  const oos = new Set<string>();
  for (const o of overrides) {
    const seq =
      o.targetKind === "ASSEMBLY_STEP"
        ? stepSeq.get(o.targetId)
        : o.targetKind === "COMPONENT_OP"
          ? opSeq.get(o.targetId)
          : seqOfProcess.get(planById.get(o.targetId)?.jobProcessId ?? -1);
    if (o.unitId == null || seq == null) continue;
    for (const stage of stagesOfSeq(o.unitId, seq)) oos.add(`${o.unitId}:${stage}`);
  }

  type Meta = { name: string; departmentId: number | null; departmentName: string | null };
  const metaOf = new Map<number | null, Map<number, Meta>>();
  for (const r of routes) {
    const m = new Map<number, Meta>();
    for (const stageNo of stageNos) {
      const first = backingOf.get(r.key)!.get(stageNo)?.[0];
      m.set(stageNo, {
        name: workOrderStageName(namesOf.get(r.key)!, stageNo),
        departmentId: first?.departmentId ?? null,
        departmentName: first?.department.name ?? null,
      });
    }
    metaOf.set(r.key, m);
  }
  // Flat view: the first route that has a process at the stage names it.
  const stageMeta = new Map<number, Meta>();
  for (const stageNo of stageNos) {
    const r = routes.find((r) => backingOf.get(r.key)!.has(stageNo)) ?? routes[0];
    stageMeta.set(stageNo, metaOf.get(r.key)!.get(stageNo)!);
  }

  const counts = { openHolds: 0, overdue: 0, outOfSequence: overrides.length };
  const stageTotals = new Map<number, { done: number; total: number }>();
  const lineTotals = new Map<number | null, Map<number, { done: number; total: number }>>(routes.map((r) => [r.key, new Map()]));
  const boardUnits: BoardUnit[] = spines.map((u) => {
    const cells: Record<number, BoardCell> = {};
    let current: BoardUnit["currentStage"] = null;
    const key = keyOfUnit.get(u.unitId) ?? null;
    const meta = metaOf.get(key)!;
    for (const seg of u.segments) {
      const procs = backingOf.get(key)!.get(seg.stageNo) ?? [];
      const found = procs
        .map((p) => planAt.get(`${p.id}:${u.unitId}`) ?? planAt.get(`${p.id}:job`))
        .filter((p): p is NonNullable<typeof p> => !!p);
      const open = found.filter((p) => p.status !== "COMPLETE");
      const allComplete = found.length > 0 && open.length === 0;
      const finishes = found.map((p) => p.actualFinish).filter((d): d is Date => !!d);
      const planned = open.map((p) => p.plannedFinish).filter((d): d is Date => !!d);
      const late = planned.filter((d) => d.getTime() < now);
      const items = itemCount.get(`${u.unitId}:${seg.stageNo}`) ?? { done: 0, total: 0 };
      const status = seg.status as BoardStatus;
      const view = deriveCell({
        status,
        hasPlans: found.length > 0,
        rejected: !!seg.rejected,
        doneAt: allComplete && finishes.length ? new Date(Math.max(...finishes.map((d) => d.getTime()))).toISOString() : null,
        plannedAt: planned.length ? new Date(Math.max(...planned.map((d) => d.getTime()))).toISOString() : null,
        daysLate: late.length ? Math.ceil((now - Math.min(...late.map((d) => d.getTime()))) / DAY) : null,
        itemsDone: items.done,
        itemsTotal: items.total,
        outOfSequence: oos.has(`${u.unitId}:${seg.stageNo}`),
      });
      cells[seg.stageNo] = { ...view, stageNo: seg.stageNo, governingPlanId: seg.governingPlanId ?? null };
      if (found.length > 0) {
        const t = stageTotals.get(seg.stageNo) ?? { done: 0, total: 0 };
        t.total++;
        if (status === "complete") t.done++;
        stageTotals.set(seg.stageNo, t);
        const lt = lineTotals.get(key)!.get(seg.stageNo) ?? { done: 0, total: 0 };
        lt.total++;
        if (status === "complete") lt.done++;
        lineTotals.get(key)!.set(seg.stageNo, lt);
        if (status !== "complete" && !current) current = { stageNo: seg.stageNo, name: meta.get(seg.stageNo)!.name };
      }
      if (found.length > 0 && status === "hold") counts.openHolds++;
      if (found.length > 0 && status === "overdue") counts.overdue++;
    }
    return { unitId: u.unitId, publicId: publicIdOf.get(u.unitId) ?? "", serialNo: u.serialNo, currentStage: current, cells };
  });

  const stagesFor = (meta: Map<number, Meta>, totals: Map<number, { done: number; total: number }>, nos: number[]): BoardStage[] =>
    nos.map((stageNo) => ({ stageNo, ...meta.get(stageNo)!, done: totals.get(stageNo)?.done ?? 0, total: totals.get(stageNo)?.total ?? 0 }));
  const stages = stagesFor(stageMeta, stageTotals, stageNos);
  const departments = [
    ...new Map(stages.filter((s) => s.departmentId != null).map((s) => [s.departmentId!, { id: s.departmentId!, name: s.departmentName! }])).values(),
  ];

  const lines: BoardLine[] | undefined =
    routes.length > 1
      ? routes.map((r) => {
          const nos = [...new Set(spines.filter((u) => r.unitIds.includes(u.unitId)).flatMap((u) => u.segments.map((s) => s.stageNo)))].sort((a, b) => a - b);
          return { name: r.name, stages: stagesFor(metaOf.get(r.key)!, lineTotals.get(r.key)!, nos), unitIds: r.unitIds };
        })
      : undefined;

  return { header, stages, units: boardUnits, ...(lines ? { lines } : {}), departments, counts };
}
