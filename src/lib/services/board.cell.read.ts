import { routeWhere, unitRouteKey } from "./line-route";
import { withTenant } from "@/lib/db";
import { assertClientScope, assertNotClientUser, hasRole, ROLES, type Actor } from "@/lib/authz";
import { loadStageDetail, type StageDetail } from "./stage-detail.read";
import { loadFloorUnit, type FloorRow } from "./floor.read";
import { loadOpSeqResolver } from "./_shared";
import { activeRow } from "./active-row";

/**
 * Lean Core L2.4: what the Job board's Stage Sheet shows for one unit x stage.
 * The stage-level verdict, dates, linked QCP points and delay history are
 * loadStageDetail's; this adds the item checklist (the steps and operations
 * that roll up into the stage) with who did it, reported vs recorded time,
 * the QC result and any out-of-sequence override, and the role-correct action
 * for each: the Floor read model's row (Start / Mark done, department-scoped)
 * or QC's Accept / Reject on a submitted item.
 */

export interface BoardItem {
  key: string;
  kind: "ASSEMBLY_STEP" | "COMPONENT_OP";
  id: number;
  title: string;
  group: string;
  status: string;
  stepKind: "WORK" | "INSPECTION" | null;
  /** The welder or person who did the work, else who submitted it. */
  who: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  reportedStartAt: string | null;
  reportedFinishAt: string | null;
  qc: { state: "ACCEPTED" | "REJECTED" | "WAITING"; by: string | null; reason: string | null; at: string | null } | null;
  overrides: Array<{ category: string; note: string | null; by: string; at: string }>;
  /** Start / Mark done for this viewer (Floor read model); null = read-only. */
  floor: FloorRow | null;
  /** QC may Accept / Reject: submitted work, or an inspection step still open. */
  canInspect: boolean;
}

export interface BoardCellDetail {
  detail: StageDetail;
  unit: { id: number; publicId: string };
  items: BoardItem[];
  canRecord: boolean;
  floorContext: {
    jobId: number;
    serialNo: string;
    overrideCategories: readonly string[];
    welders: Array<{ id: number; name: string; employeeCode: string }>;
    lateCategories: Array<{ id: number; name: string }>;
  } | null;
}

export async function loadBoardCell(
  actor: Actor,
  jobId: number,
  unitId: number,
  stageNo: number,
): Promise<BoardCellDetail | null> {
  assertNotClientUser(actor);
  const detail = await loadStageDetail(actor, jobId, unitId, stageNo);
  if (!detail) return null;

  const raw = await withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true, familyId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);
    const unit = await tx.unit.findFirst({ where: { id: unitId, jobId }, select: { id: true, publicId: true } });
    if (!unit) return null;

    const seqs = (
      await tx.jobProcess.findMany({
        where: { jobId, included: true, workOrderStages: { has: stageNo }, ...routeWhere(await unitRouteKey(tx, unitId)) },
        select: { seq: true },
      })
    ).map((p) => p.seq);
    const resolve = await loadOpSeqResolver(tx, job.familyId);

    const [steps, allOps, overrides] = await Promise.all([
      tx.assemblyStep.findMany({
        where: { ...activeRow, jobId, unitId, templateStep: { leadTimeProcessSeq: { in: seqs } } },
        orderBy: { seq: "asc" },
        select: {
          id: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          reportedStartAt: true,
          reportedFinishAt: true,
          requiresQc: true,
          templateStep: { select: { activity: true, groupName: true, kind: true } },
          performedByWelder: { select: { name: true } },
          performedByUser: { select: { name: true } },
          submitter: { select: { name: true } },
          verifier: { select: { name: true } },
        },
      }),
      tx.componentOperation.findMany({
        where: { ...activeRow, jobId, component: { unitId } },
        orderBy: [{ componentId: "asc" }, { seq: "asc" }],
        select: {
          id: true,
          seq: true,
          operationId: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          reportedStartAt: true,
          reportedFinishAt: true,
          requiresQc: true,
          operation: { select: { name: true } },
          component: { select: { tag: true, routeVersionId: true, componentType: { select: { name: true } } } },
          performedByWelder: { select: { name: true } },
          performedByUser: { select: { name: true } },
          submitter: { select: { name: true } },
          verifier: { select: { name: true } },
        },
      }),
      tx.sequenceOverride.findMany({
        where: { jobId, unitId, targetKind: { in: ["ASSEMBLY_STEP", "COMPONENT_OP"] } },
        select: { targetKind: true, targetId: true, category: true, note: true, createdAt: true, creator: { select: { name: true } } },
      }),
    ]);
    const ops = allOps.filter((o) => {
      const seq = resolve({ operationId: o.operationId, seq: o.seq, routeVersionId: o.component.routeVersionId });
      return seq != null && seqs.includes(seq);
    });

    const [stepRej, opRej] = await Promise.all([
      steps.length
        ? tx.assemblyStepRejection.findMany({
            where: { assemblyStepId: { in: steps.map((s) => s.id) } },
            orderBy: { rejectedAt: "desc" },
            select: { assemblyStepId: true, detail: true, rejectedAt: true },
          })
        : Promise.resolve([]),
      ops.length
        ? tx.componentOperationRejection.findMany({
            where: { componentOperationId: { in: ops.map((o) => o.id) } },
            orderBy: { rejectedAt: "desc" },
            select: { componentOperationId: true, detail: true, rejectedAt: true },
          })
        : Promise.resolve([]),
    ]);
    return { unit, steps, ops, overrides, stepRej, opRej };
  });
  if (!raw) return null;

  const floor = await loadFloorUnit(actor, { unitId }, { spine: false });
  const floorRow = new Map((floor?.rows ?? []).map((r) => [r.key, r]));
  const isQc = hasRole(actor, ROLES.QC);
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const overridesFor = (kind: string, id: number) =>
    raw.overrides
      .filter((o) => o.targetKind === kind && o.targetId === id)
      .map((o) => ({ category: o.category, note: o.note, by: o.creator.name, at: o.createdAt.toISOString() }));

  const qcOf = (
    r: { status: string; requiresQc: boolean; verifier: { name: string } | null; finishedAt: Date | null },
    rej: { detail: string | null; rejectedAt: Date } | undefined,
  ): BoardItem["qc"] => {
    if (r.status === "COMPLETE" && r.requiresQc) return { state: "ACCEPTED", by: r.verifier?.name ?? null, reason: null, at: iso(r.finishedAt) };
    if (r.status === "SUBMITTED") return { state: "WAITING", by: null, reason: null, at: null };
    if (rej) return { state: "REJECTED", by: null, reason: rej.detail, at: rej.rejectedAt.toISOString() };
    return null;
  };

  const items: BoardItem[] = [
    ...raw.steps.map((s): BoardItem => {
      const key = `ASSEMBLY_STEP:${s.id}`;
      const inspection = s.templateStep.kind === "INSPECTION";
      return {
        key,
        kind: "ASSEMBLY_STEP",
        id: s.id,
        title: s.templateStep.activity,
        group: s.templateStep.groupName,
        status: s.status,
        stepKind: inspection ? "INSPECTION" : "WORK",
        who: s.performedByWelder?.name ?? s.performedByUser?.name ?? s.submitter?.name ?? null,
        startedAt: iso(s.startedAt),
        finishedAt: iso(s.finishedAt),
        reportedStartAt: iso(s.reportedStartAt),
        reportedFinishAt: iso(s.reportedFinishAt),
        qc: qcOf(s, raw.stepRej.find((r) => r.assemblyStepId === s.id)),
        overrides: overridesFor("ASSEMBLY_STEP", s.id),
        floor: floorRow.get(key) ?? null,
        canInspect: isQc && s.status !== "COMPLETE" && (s.status === "SUBMITTED" || inspection),
      };
    }),
    ...raw.ops.map((o): BoardItem => {
      const key = `COMPONENT_OP:${o.id}`;
      const type = o.component.componentType.name;
      return {
        key,
        kind: "COMPONENT_OP",
        id: o.id,
        title: o.operation.name,
        group: o.component.tag.toLowerCase().includes(type.toLowerCase()) ? o.component.tag : `${type} · ${o.component.tag}`,
        status: o.status,
        stepKind: null,
        who: o.performedByWelder?.name ?? o.performedByUser?.name ?? o.submitter?.name ?? null,
        startedAt: iso(o.startedAt),
        finishedAt: iso(o.finishedAt),
        reportedStartAt: iso(o.reportedStartAt),
        reportedFinishAt: iso(o.reportedFinishAt),
        qc: qcOf(o, raw.opRej.find((r) => r.componentOperationId === o.id)),
        overrides: overridesFor("COMPONENT_OP", o.id),
        floor: floorRow.get(key) ?? null,
        canInspect: isQc && o.status === "SUBMITTED",
      };
    }),
  ];

  return {
    detail,
    unit: raw.unit,
    items,
    canRecord: floor?.canRecord ?? false,
    floorContext: floor
      ? {
          jobId,
          serialNo: floor.unit.serialNo,
          overrideCategories: floor.overrideCategories,
          welders: floor.welders,
          lateCategories: floor.lateCategories,
        }
      : null,
  };
}
