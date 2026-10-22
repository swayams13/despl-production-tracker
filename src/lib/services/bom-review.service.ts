import { withJob, withTenant, type Tx } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { assertNotClientUser, requireRole, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { BOM_REVIEW_ROLES } from "@/lib/shared/stores-access";
import { resolveReviewRowSchema, type ResolveReviewRowInput } from "@/lib/shared/schemas";
import { activeRow } from "./active-row";
import { buildComponentRows, componentKey, writeComponentRows } from "./component.service";
import { buildAssemblyStepRows } from "./assembly.service";
import { LineRules } from "./config-rules";
import { loadSkippedQcpItems } from "./assembly-qcp-match";
import { recordQcpExecutionTx } from "./qcp.service";
import { lockFloorUnits, rollupForAssemblyStep, rollupForComponentOperation } from "./_shared";
import { diffSteps, Recorder, renumberUnitSteps } from "./bom-release-diff";

/**
 * J5c: Engineering or the Production Head settles a started floor row that a BOM re-release flagged
 * (`needs_review`): Keep it as it is, Replace it with what the current BOM wants, or Cancel it.
 * No maker-checker (open point 2, default accepted): there is no QC verify here. A reason of at least
 * five characters is required and every action is audited with the full old row. QC history stays on the
 * retired row; a Replace never copies a heat pick or an issue, so H2 makes the new part re-issue material.
 */

export interface ReviewResult {
  action: "KEEP" | "REPLACE" | "CANCEL";
  kind: "ASSEMBLY_STEP" | "COMPONENT_OP";
  id: number;
  /** The row that took its place (Replace). */
  replacedBy: number | null;
}

const OPEN_NCR = ["OPEN", "REWORK_IN_PROGRESS"] as const;

export async function resolveReviewRow(actor: Actor, input: ResolveReviewRowInput): Promise<ReviewResult> {
  const { kind, id, action, reason } = resolveReviewRowSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ...BOM_REVIEW_ROLES);
  const why = reason.trim();
  if (why.length < 5) {
    throw new AppError(ERROR_CODES.REASON_REQUIRED, { field: "reason" }, "Give a reason of at least a few words. It is recorded with your name.");
  }

  // j5c: history (found by id, then judged inside the locks)
  const found = await withTenant(actor.tenantId, (tx) =>
    kind === "ASSEMBLY_STEP"
      ? tx.assemblyStep
          // j5c: history
          .findFirst({ where: { id, unit: { equipment: { job: { tenantId: actor.tenantId } } } }, select: { jobId: true, unitId: true, unit: { select: { equipmentId: true } } } })
          .then((s) => (s ? { jobId: s.jobId, unitId: s.unitId, equipmentId: s.unit.equipmentId } : null))
      : tx.componentOperation
          // j5c: history
          .findFirst({
            where: { id, component: { equipment: { job: { tenantId: actor.tenantId } } } },
            select: { jobId: true, component: { select: { unitId: true, equipmentId: true } } },
          })
          .then((o) => (o ? { jobId: o.jobId, unitId: o.component.unitId, equipmentId: o.component.equipmentId } : null)),
  );
  if (!found) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: kind === "ASSEMBLY_STEP" ? "AssemblyStep" : "ComponentOperation", id });

  return withJob(
    actor.tenantId,
    found.jobId,
    async (tx) => {
      // Same locks as the release: the line's row, then the unit's floor lock (serialises with recordWork).
      await tx.$queryRaw`SELECT id FROM equipments WHERE id = ${found.equipmentId} FOR UPDATE`;
      await lockFloorUnits(tx, found.jobId, [found.unitId]);
      return kind === "ASSEMBLY_STEP" ? reviewStep(tx, actor, id, action, why, found.equipmentId) : reviewOp(tx, actor, id, action, why, found.equipmentId);
    },
    { timeoutMs: 60_000 },
  );
}

/** Replace and Cancel wait for QC and for open non-conformances; Keep never does. */
async function assertNotBlocked(tx: Tx, kind: "ASSEMBLY_STEP" | "COMPONENT_OP", id: number, status: string): Promise<void> {
  if (status === "SUBMITTED") throw new AppError(ERROR_CODES.BOM_REVIEW_BLOCKED, { reason: "QC_PENDING", kind, id });
  const open = await tx.ncr.count({
    where: {
      status: { in: [...OPEN_NCR] },
      OR:
        kind === "ASSEMBLY_STEP"
          ? [{ assemblyStepRejection: { assemblyStepId: id } }, { targetAssemblyStepId: id }]
          : [{ componentOperationRejection: { componentOperationId: id } }, { targetComponentOperationId: id }],
    },
  });
  if (open > 0) throw new AppError(ERROR_CODES.BOM_REVIEW_BLOCKED, { reason: "NCR_OPEN", kind, id });
}

async function desired(tx: Tx, actor: Actor, equipmentId: number, unitIds: number[]) {
  const equipment = await tx.equipment.findFirstOrThrow({
    where: { id: equipmentId, job: { tenantId: actor.tenantId } },
    select: { id: true, jobId: true, equipmentTypeId: true, config: true, assemblyTemplateVersionId: true, job: { select: { familyId: true } } },
  });
  const revision = await tx.bomRevision.findFirst({ where: { equipmentId, materializedAt: { not: null } }, orderBy: { revisionNo: "desc" }, select: { id: true, revisionNo: true } });
  const qcp = await tx.qcpTemplate.findFirst({ where: { jobId: equipment.jobId }, select: { id: true } });
  const rules = await LineRules.load(tx, equipmentId);
  return {
    equipment,
    revision,
    qcpTemplateId: qcp?.id ?? null,
    rules,
    skippedQcp: qcp ? await loadSkippedQcpItems(tx, equipment.jobId) : [],
    unitIds,
  };
}

async function currentLineItems(tx: Tx, equipmentId: number, revisionId: number | null) {
  return revisionId == null
    ? []
    : tx.bomItem.findMany({
        where: { equipmentId, bomRevisionId: revisionId },
        select: { id: true, itemNo: true, componentTypeId: true },
      });
}

// ── Assembly step ────────────────────────────────────────────────────────

async function reviewStep(tx: Tx, actor: Actor, id: number, action: ReviewResult["action"], why: string, equipmentId: number): Promise<ReviewResult> {
  await tx.$queryRaw`SELECT id FROM assembly_steps WHERE id = ${id} FOR UPDATE`;
  // j5c: history (found, then refused if retired or not flagged)
  const row = await tx.assemblyStep.findUniqueOrThrow({ where: { id }, include: { templateStep: { select: { kind: true, activity: true } }, component: { select: { bomItem: { select: { itemNo: true } } } } } });
  if (row.retiredAt) throw new AppError(ERROR_CODES.FLOOR_ROW_RETIRED, { entity: "AssemblyStep", id });
  if (!row.needsReview) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { entity: "AssemblyStep", id }, "This step is not waiting for review.");
  const base = { entityType: "AssemblyStep", entityId: id, eventPayload: { kind: "ASSEMBLY_STEP", id, reason: why } };

  if (action === "KEEP") {
    await tx.assemblyStep.update({ where: { id }, data: { needsReview: false } });
    await recordAudit(tx, actor, { ...base, action: "bom.review.keep", before: row, after: { needsReview: false, reason: why }, eventType: "BomReviewKept" });
    await rollupForAssemblyStep(tx, actor, id);
    return { action, kind: "ASSEMBLY_STEP", id, replacedBy: null };
  }
  await assertNotBlocked(tx, "ASSEMBLY_STEP", id, row.status);

  if (action === "CANCEL") {
    await tx.assemblyStep.update({ where: { id }, data: { retiredAt: new Date(), retiredReason: `cancelled in review: ${why}`, needsReview: false } });
    await recordAudit(tx, actor, { ...base, action: "bom.review.cancel", before: row, after: { needsReview: false, retired: true, reason: why }, eventType: "BomReviewCancelled" });
    await rollupForAssemblyStep(tx, actor, id);
    return { action, kind: "ASSEMBLY_STEP", id, replacedBy: null };
  }

  // REPLACE: what the current release wants for the same key.
  const ctx = await desired(tx, actor, equipmentId, [row.unitId]);
  const itemNo = row.component?.bomItem?.itemNo ?? null;
  const built = await buildAssemblyStepRows(tx, {
    tenantId: actor.tenantId,
    jobId: row.jobId,
    familyId: ctx.equipment.job.familyId,
    unitIds: [row.unitId],
    qcpTemplateId: ctx.qcpTemplateId,
    equipmentTypeId: ctx.equipment.equipmentTypeId,
    rules: ctx.rules,
    skippedQcp: ctx.skippedQcp,
    equipmentId,
    answers: (ctx.equipment.config as Record<string, unknown> | null) ?? {},
    pinnedVersionId: ctx.equipment.assemblyTemplateVersionId,
  });
  const itemNoOf = new Map(
    // j5c: history (part -> BOM item number, retired parts included)
    (await tx.component.findMany({ where: { equipmentId }, select: { id: true, bomItem: { select: { itemNo: true } } } })).map((c) => [c.id, c.bomItem?.itemNo ?? null] as const),
  );
  const want = built.rows.find(
    (w) =>
      w.unitId === row.unitId &&
      w.templateStepId === row.templateStepId &&
      (w.plannedJointId ?? null) === (row.plannedJointId ?? null) &&
      (w.componentId != null ? (itemNoOf.get(w.componentId) ?? null) : null) === itemNo,
  );
  if (!want) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { entity: "AssemblyStep", id }, "The current BOM has nothing to replace this step with. Keep it or cancel it.");

  await tx.assemblyStep.update({ where: { id }, data: { retiredAt: new Date(), retiredReason: `replaced in review: ${why}`, needsReview: false } });
  await tx.$executeRaw`UPDATE assembly_steps SET seq = -seq WHERE unit_id = ${row.unitId} AND retired_at IS NULL AND seq > 0`;
  const created = await tx.assemblyStep.create({ data: { ...want, seq: -10_000_000 }, select: { id: true } });
  await renumberUnitSteps(tx, [row.unitId]);

  // The hold point of a replaced inspection reopens: the new row has to be inspected.
  if (row.templateStep.kind === "INSPECTION" && want.qcpItemId != null) {
    const blocking = await tx.qcpItem.count({ where: { id: want.qcpItemId, partyCodes: { some: { qcpCode: { blocksCompletion: true } } } } });
    if (blocking > 0) {
      const exec = await recordQcpExecutionTx(tx, actor, { qcpItemId: want.qcpItemId, unitId: row.unitId, result: "PENDING", jobId: row.jobId, remarks: `Step replaced in BOM review: ${why}` });
      await recordAudit(tx, actor, {
        action: "qcp.record",
        entityType: "QcpExecution",
        entityId: exec.id,
        after: { qcpItemId: want.qcpItemId, unitId: row.unitId, attemptNo: exec.attemptNo, result: "PENDING", reopenedBy: "bom.review.replace" },
        eventType: "QcpExecutionRecorded",
        eventPayload: { qcpItemId: want.qcpItemId, unitId: row.unitId, attemptNo: exec.attemptNo, result: "PENDING" },
      });
    }
  }
  await recordAudit(tx, actor, { ...base, action: "bom.review.replace", before: row, after: { retired: true, replacedBy: created.id, reason: why }, eventType: "BomReviewReplaced" });
  await rollupForAssemblyStep(tx, actor, created.id);
  return { action, kind: "ASSEMBLY_STEP", id, replacedBy: created.id };
}

// ── Component operation ──────────────────────────────────────────────────

async function reviewOp(tx: Tx, actor: Actor, id: number, action: ReviewResult["action"], why: string, equipmentId: number): Promise<ReviewResult> {
  await tx.$queryRaw`SELECT id FROM component_operations WHERE id = ${id} FOR UPDATE`;
  // j5c: history (found, then refused if retired or not flagged)
  const row = await tx.componentOperation.findUniqueOrThrow({
    where: { id },
    include: { component: { select: { id: true, tag: true, unitId: true, jobId: true, componentTypeId: true, routeVersionId: true, governingDrawingId: true, bomItem: { select: { itemNo: true } }, routeVersion: { select: { routeId: true } } } } },
  });
  if (row.retiredAt) throw new AppError(ERROR_CODES.FLOOR_ROW_RETIRED, { entity: "ComponentOperation", id });
  if (!row.needsReview) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { entity: "ComponentOperation", id }, "This operation is not waiting for review.");
  const base = { entityType: "ComponentOperation", entityId: id, eventPayload: { kind: "COMPONENT_OP", id, reason: why } };

  if (action === "KEEP") {
    await tx.componentOperation.update({ where: { id }, data: { needsReview: false } });
    await recordAudit(tx, actor, { ...base, action: "bom.review.keep", before: row, after: { needsReview: false, reason: why }, eventType: "BomReviewKept" });
    await rollupForComponentOperation(tx, actor, id);
    return { action, kind: "COMPONENT_OP", id, replacedBy: null };
  }
  await assertNotBlocked(tx, "COMPONENT_OP", id, row.status);

  if (action === "CANCEL") {
    await tx.componentOperation.update({ where: { id }, data: { retiredAt: new Date(), retiredReason: `cancelled in review: ${why}`, needsReview: false } });
    await recordAudit(tx, actor, { ...base, action: "bom.review.cancel", before: row, after: { needsReview: false, retired: true, reason: why }, eventType: "BomReviewCancelled" });
    await rollupForComponentOperation(tx, actor, id);
    return { action, kind: "COMPONENT_OP", id, replacedBy: null };
  }

  // REPLACE
  const comp = row.component;
  const ctx = await desired(tx, actor, equipmentId, comp.unitId == null ? [] : [comp.unitId]);
  const itemNo = comp.bomItem?.itemNo ?? null;
  const gone = new AppError(ERROR_CODES.VALIDATION_FAILED, { entity: "ComponentOperation", id }, "The current BOM has nothing to replace this operation with. Keep it or cancel it.");
  if (itemNo == null) throw gone;
  const items = await currentLineItems(tx, equipmentId, ctx.revision?.id ?? null);
  const line = items.find((b) => b.itemNo === itemNo && b.componentTypeId != null);
  if (!line) throw gone;
  const build = (pin: boolean) =>
    buildComponentRows(tx, {
      familyId: ctx.equipment.job.familyId,
      equipmentId,
      bomItemIds: [line.id],
      jobId: row.jobId,
      opts: { release: true, rules: ctx.rules, pinnedRoutes: pin && comp.routeVersionId != null ? new Map([[componentKey(comp.unitId, itemNo), comp.routeVersionId]]) : undefined },
    }).then((b) => b.rows.find((r) => r.unitId === comp.unitId));
  const fresh = await build(false);
  if (!fresh) throw gone;
  const componentLevel = fresh.componentTypeId !== comp.componentTypeId || fresh.routeId !== comp.routeVersion?.routeId || fresh.tag !== comp.tag;

  if (!componentLevel) {
    const same = (await build(true)) ?? fresh;
    const w = same.ops.find((o) => o.seq === row.seq);
    if (!w) throw gone;
    await tx.componentOperation.update({ where: { id }, data: { retiredAt: new Date(), retiredReason: `replaced in review: ${why}`, needsReview: false } });
    const created = await tx.componentOperation.create({
      data: { componentId: comp.id, seq: w.seq, operationId: w.operationId, requiresQc: w.requiresQc, ...(w.qtyPlanned != null ? { qtyPlanned: w.qtyPlanned } : {}), jobId: row.jobId },
      select: { id: true },
    });
    await recordAudit(tx, actor, { ...base, action: "bom.review.replace", before: row, after: { retired: true, replacedBy: created.id, reason: why }, eventType: "BomReviewReplaced" });
    await rollupForComponentOperation(tx, actor, created.id);
    return { action, kind: "COMPONENT_OP", id, replacedBy: created.id };
  }

  // A part-level change replaces the whole part: every operation of it must be free to go.
  // j5c: history (the whole part's operations, active ones, are judged here)
  const siblings = await tx.componentOperation.findMany({ where: { ...activeRow, componentId: comp.id }, select: { id: true, status: true } });
  for (const s of siblings) await assertNotBlocked(tx, "COMPONENT_OP", s.id, s.status);
  const now = new Date();
  await tx.componentOperation.updateMany({ where: { ...activeRow, componentId: comp.id }, data: { retiredAt: now, retiredReason: `replaced in review: ${why}`, needsReview: false } });
  await tx.component.update({ where: { id: comp.id }, data: { retiredAt: now, retiredReason: `replaced in review: ${why}` } });
  const made = await writeComponentRows(tx, row.jobId, equipmentId, [fresh]);
  const newId = made.componentIds[0];
  // Copy the drawing link; never the heat pick or the issue (H2 makes the new part re-issue its material).
  if (comp.governingDrawingId != null) await tx.component.update({ where: { id: newId }, data: { governingDrawingId: comp.governingDrawingId } });
  // Its PER_COMPONENT steps follow the new part: not-started ones are re-keyed or replaced, started ones are flagged.
  const stepsBuilt = await buildAssemblyStepRows(tx, {
    tenantId: actor.tenantId,
    jobId: row.jobId,
    familyId: ctx.equipment.job.familyId,
    unitIds: comp.unitId == null ? [] : [comp.unitId],
    qcpTemplateId: ctx.qcpTemplateId,
    equipmentTypeId: ctx.equipment.equipmentTypeId,
    rules: ctx.rules,
    skippedQcp: ctx.skippedQcp,
    equipmentId,
    answers: (ctx.equipment.config as Record<string, unknown> | null) ?? {},
    pinnedVersionId: ctx.equipment.assemblyTemplateVersionId,
  });
  const rec = new Recorder(new Map());
  await diffSteps(tx, rec, {
    equipmentId,
    unitIds: comp.unitId == null ? [] : [comp.unitId],
    desired: stepsBuilt.rows,
    retireData: { retiredAt: now, retiredReason: `replaced in review: ${why}`, needsReview: false },
    onlyComponentIds: [comp.id, newId],
  });
  const newOps = await tx.componentOperation.findMany({ where: { ...activeRow, componentId: newId }, select: { id: true } });
  await recordAudit(tx, actor, {
    ...base,
    action: "bom.review.replace",
    before: row,
    after: { retired: true, replacedBy: newOps[0]?.id ?? null, replacedComponent: newId, reason: why, stepChanges: rec.diff.counts.step },
    eventType: "BomReviewReplaced",
  });
  await rollupForComponentOperation(tx, actor, id);
  if (newOps[0]) await rollupForComponentOperation(tx, actor, newOps[0].id);
  for (const t of rec.touched) {
    if (t.kind === "STEP") await rollupForAssemblyStep(tx, actor, t.id);
  }
  return { action, kind: "COMPONENT_OP", id, replacedBy: newOps[0]?.id ?? null };
}
