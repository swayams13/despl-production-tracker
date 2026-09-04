import { withTenant, type Tx } from "@/lib/db";
import { type Actor, assertMakerChecker, assertNotClientUser, requireDepartmentScope, ROLES } from "@/lib/authz";
import { audited, recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { assertStateTransition } from "./state-machine";
import { assertPerformedByValid, createWeldJointTx, recordNdtResultTx } from "./welding.service";
import { closeNcr } from "./ncr.service";
import { notify, userIdsWithRole } from "./notifications.service";
import { recordQcpExecutionTx } from "./qcp.service";
import {
  startAssemblyStepSchema,
  submitAssemblyStepSchema,
  verifyAssemblyStepSchema,
  rejectAssemblyStepSchema,
  type StartAssemblyStepInput,
  type SubmitAssemblyStepInput,
  type VerifyAssemblyStepInput,
  type RejectAssemblyStepInput,
} from "@/lib/shared/schemas";
import type { AssemblyStep, OperationStatus } from "@/generated/prisma/client";

/**
 * F8's third consumer (state-machine.ts's own comment named this ahead of
 * time). Mirrors component.service.ts as closely as AssemblyStep's shape
 * allows (CLAUDE.md #1/#2/#3/#5/#8/#12) — same simplification component.
 * service.ts makes over process.service.ts: no HOLD/resume, and ordering is
 * "the previous seq on this unit's assembly sequence must be COMPLETE," not
 * a full predecessor DAG (AssemblyTemplateStep.seq is a flat 1..54 order).
 *
 * Grain: AssemblyStep is the vessel-level A–Q checkpoint (addendum §2) —
 * distinct from ComponentOperation (per-component fabrication) and
 * JobProcess (the 36-process spine). Phase 3 rolls all three up together;
 * this file only tracks AssemblyStep's own state.
 */

export type AssemblyStepAction = "start" | "submit" | "verify" | "reject";

export const ASSEMBLY_STEP_TRANSITIONS: Record<
  AssemblyStepAction,
  { from: OperationStatus[]; to: OperationStatus }
> = {
  start: { from: ["NOT_STARTED"], to: "IN_PROGRESS" },
  submit: { from: ["IN_PROGRESS"], to: "SUBMITTED" },
  verify: { from: ["SUBMITTED"], to: "COMPLETE" },
  // Same default component.service.ts's F5 reject uses: rejected work
  // restarts from the SAME step, not an earlier one.
  reject: { from: ["SUBMITTED"], to: "IN_PROGRESS" },
};

export function assertAssemblyStepTransition(action: AssemblyStepAction, from: OperationStatus): OperationStatus {
  return assertStateTransition(ASSEMBLY_STEP_TRANSITIONS, action, from, "AssemblyStep");
}

/**
 * Locks the row FOR UPDATE and re-reads tenant-scoped (join through
 * unit.equipment.job.tenantId), same discipline as component.service.ts's
 * lockComponentOperationForUpdate. Also returns the template step's
 * defaultDepartmentId (for the department-scope check) and the previous
 * step on the same unit (flat seq order, not a DAG — no route-aware lookup
 * needed the way ComponentOperation's canonical-route fallback is).
 */
async function lockAssemblyStepForUpdate(
  tx: Tx,
  assemblyStepId: number,
  tenantId: number,
): Promise<{
  step: AssemblyStep & { templateStep: { seq: number; defaultDepartmentId: number; kind: string; jointRef: string | null } };
  previousStep: { seq: number; status: OperationStatus } | null;
}> {
  await tx.$queryRaw`SELECT id FROM assembly_steps WHERE id = ${assemblyStepId} FOR UPDATE`;

  const step = await tx.assemblyStep.findFirst({
    where: { id: assemblyStepId, unit: { equipment: { job: { tenantId } } } },
    include: { templateStep: { select: { seq: true, defaultDepartmentId: true, kind: true, jointRef: true } } },
  });
  if (!step) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "AssemblyStep", assemblyStepId });

  const previousStep =
    step.templateStep.seq > 1
      ? await tx.assemblyStep.findFirst({
          where: { unitId: step.unitId, templateStep: { seq: step.templateStep.seq - 1 } },
          select: { seq: true, status: true },
        })
      : null;

  return { step, previousStep };
}

/**
 * NOT_STARTED -> IN_PROGRESS. Department-scoped via the template step's
 * defaultDepartmentId. Gate: the previous seq on this unit's assembly
 * sequence must be COMPLETE, or this is seq 1.
 */
export async function startAssemblyStep(actor: Actor, input: StartAssemblyStepInput): Promise<AssemblyStep> {
  const { assemblyStepId } = startAssemblyStepSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { step, previousStep } = await lockAssemblyStepForUpdate(tx, assemblyStepId, actor.tenantId);
    requireDepartmentScope(actor, step.templateStep.defaultDepartmentId);
    const to = assertAssemblyStepTransition("start", step.status);

    if (previousStep && previousStep.status !== "COMPLETE") {
      throw new AppError(ERROR_CODES.GATING_BLOCKED, {
        reason: "previous step in this unit's assembly sequence is not complete",
        blockedBySeq: previousStep.seq,
        blockedByStatus: previousStep.status,
      });
    }

    // N3 (Phase 5): mirrors component.service.ts's startComponentOperation —
    // defensive stamp for a reworked step that legitimately returns to
    // NOT_STARTED, guarded so it never clobbers dispositionNcr's own stamp.
    const openReworkNcr = await tx.ncr.findFirst({
      where: {
        status: "REWORK_IN_PROGRESS",
        reworkStartedAt: null,
        assemblyStepRejection: { assemblyStepId: step.id },
      },
    });

    return audited(tx, actor, async () => {
      const updated = await tx.assemblyStep.update({
        where: { id: step.id },
        data: { status: to, startedAt: new Date() },
      });
      if (openReworkNcr) {
        await tx.ncr.update({ where: { id: openReworkNcr.id }, data: { reworkStartedAt: new Date() } });
      }
      return {
        result: updated,
        audit: {
          action: "assemblyStep.start",
          entityType: "AssemblyStep",
          entityId: step.id,
          before: { status: step.status },
          after: { status: updated.status, startedAt: updated.startedAt },
          eventType: "AssemblyStepStarted",
          eventPayload: { assemblyStepId: step.id, unitId: step.unitId },
        },
      };
    });
  });
}

/**
 * IN_PROGRESS -> SUBMITTED (maker step). For a WORK step whose template step
 * carries a jointRef, requires binding a WeldJoint — an already-logged one
 * (weldJointId) or inline fields to create one now (newJoint), refused
 * VALIDATION_FAILED with neither. Steps with no jointRef ignore both.
 */
export async function submitAssemblyStep(actor: Actor, input: SubmitAssemblyStepInput): Promise<AssemblyStep> {
  const { assemblyStepId, performedByWelderId, performedByUserId, remarks, weldJointId, newJoint } =
    submitAssemblyStepSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { step } = await lockAssemblyStepForUpdate(tx, assemblyStepId, actor.tenantId);
    requireDepartmentScope(actor, step.templateStep.defaultDepartmentId);
    const to = assertAssemblyStepTransition("submit", step.status);

    if (step.templateStep.jointRef != null && weldJointId == null && newJoint == null && step.weldJointId == null) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { assemblyStepId, jointRef: step.templateStep.jointRef },
        "This weld step needs a joint bound before it can be submitted — pick an existing one or log it now.",
      );
    }

    await assertPerformedByValid(tx, actor, performedByWelderId, performedByUserId);

    return audited(tx, actor, async () => {
      let boundWeldJointId = weldJointId ?? step.weldJointId ?? null;
      if (newJoint) {
        const unit = await tx.unit.findFirstOrThrow({ where: { id: step.unitId }, select: { equipmentId: true } });
        const equipment = await tx.equipment.findFirstOrThrow({
          where: { id: unit.equipmentId },
          select: { jobId: true },
        });
        const joint = await createWeldJointTx(tx, actor, equipment.jobId, step.unitId, null, newJoint);
        boundWeldJointId = joint.id;
      }

      const updated = await tx.assemblyStep.update({
        where: { id: step.id },
        data: {
          status: to,
          submittedBy: actor.userId,
          performedByWelderId: performedByWelderId ?? undefined,
          performedByUserId: performedByUserId ?? undefined,
          remarks: remarks ?? undefined,
          weldJointId: boundWeldJointId ?? undefined,
        },
      });
      return {
        result: updated,
        audit: {
          action: "assemblyStep.submit",
          entityType: "AssemblyStep",
          entityId: step.id,
          before: { status: step.status, submittedBy: step.submittedBy },
          after: {
            status: updated.status,
            submittedBy: updated.submittedBy,
            performedByWelderId: updated.performedByWelderId,
            performedByUserId: updated.performedByUserId,
            remarks: updated.remarks,
            weldJointId: updated.weldJointId,
          },
          eventType: "AssemblyStepSubmitted",
          eventPayload: { assemblyStepId: step.id, submittedBy: actor.userId },
        },
      };
    });
  });
}

/**
 * SUBMITTED -> COMPLETE (checker step). Maker-checker (#3): QC role AND
 * actor != submittedBy, no admin exception.
 */
export async function verifyAssemblyStep(actor: Actor, input: VerifyAssemblyStepInput): Promise<AssemblyStep> {
  const { assemblyStepId } = verifyAssemblyStepSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { step } = await lockAssemblyStepForUpdate(tx, assemblyStepId, actor.tenantId);
    assertMakerChecker(actor, step.submittedBy);
    const to = assertAssemblyStepTransition("verify", step.status);

    // N1 (Phase 5): re-verifying a reworked step closes its open Ncr(s) and
    // records the elapsed rework time. findMany, not findFirst — see the
    // matching comment in component.service.ts's verifyComponentOperation
    // (task review Critical #1): repeated reject→resubmit→reject cycles can
    // leave more than one Ncr open for the same step.
    const openNcrs = await tx.ncr.findMany({
      where: { status: { not: "CLOSED" }, assemblyStepRejection: { assemblyStepId: step.id } },
    });

    return audited(tx, actor, async () => {
      const updated = await tx.assemblyStep.update({
        where: { id: step.id },
        data: { status: to, finishedAt: new Date(), verifiedBy: actor.userId },
      });
      for (const ncr of openNcrs) {
        await closeNcr(tx, actor, { ncrId: ncr.id });
      }
      // A4: an INSPECTION step verifying IS the QCP checkpoint result — record
      // it so assertNoOpenHoldPoint and the QCP/hold-point view see the same
      // truth the assembly view just showed, instead of the linked QcpItem
      // staying stuck PENDING forever (verify already proved QC role + not
      // the submitter, via assertMakerChecker above).
      if (step.templateStep.kind === "INSPECTION" && step.qcpItemId != null) {
        const exec = await recordQcpExecutionTx(tx, actor, {
          qcpItemId: step.qcpItemId,
          unitId: step.unitId,
          result: "ACCEPTED",
        });
        await recordAudit(tx, actor, {
          action: "qcp.record",
          entityType: "QcpExecution",
          entityId: exec.id,
          after: { qcpItemId: step.qcpItemId, unitId: step.unitId, attemptNo: exec.attemptNo, result: "ACCEPTED" },
          eventType: "QcpExecutionRecorded",
          eventPayload: { qcpItemId: step.qcpItemId, unitId: step.unitId, attemptNo: exec.attemptNo, result: "ACCEPTED" },
        });
      }
      return {
        result: updated,
        audit: {
          action: "assemblyStep.verify",
          entityType: "AssemblyStep",
          entityId: step.id,
          before: { status: step.status, verifiedBy: step.verifiedBy },
          after: { status: updated.status, verifiedBy: updated.verifiedBy, finishedAt: updated.finishedAt },
          eventType: "AssemblyStepVerified",
          eventPayload: { assemblyStepId: step.id, submittedBy: step.submittedBy, verifiedBy: actor.userId },
        },
      };
    });
  });
}

/**
 * SUBMITTED -> IN_PROGRESS (checker rejects). Same maker-checker gate as
 * verify. A category is mandatory; the rejection is recorded in
 * AssemblyStepRejection (mirrors ComponentOperationRejection) and
 * submittedBy is cleared. When the step has a bound weldJointId and a
 * testTypeId is given, also records an NdtResult(REJECT) against that
 * joint in the same transaction — one action from QC's side, and it's what
 * makes "a PAUT/TOFD reject shows against the welder's repair rate" true
 * (welding.read.ts's repair-rate calc reads NdtResult, keyed off the
 * joint's welders).
 */
export async function rejectAssemblyStep(actor: Actor, input: RejectAssemblyStepInput): Promise<AssemblyStep> {
  const { assemblyStepId, categoryId, detail, testTypeId } = rejectAssemblyStepSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { step } = await lockAssemblyStepForUpdate(tx, assemblyStepId, actor.tenantId);
    assertMakerChecker(actor, step.submittedBy);
    const to = assertAssemblyStepTransition("reject", step.status);

    if (testTypeId != null && step.weldJointId == null) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { assemblyStepId },
        "No weld joint is bound to this step yet — an NDT result needs a joint to attach to.",
      );
    }

    return audited(tx, actor, async () => {
      const updated = await tx.assemblyStep.update({
        where: { id: step.id },
        data: { status: to, submittedBy: null },
      });
      const rejection = await tx.assemblyStepRejection.create({
        data: { assemblyStepId: step.id, categoryId, detail: detail ?? null, rejectedBy: actor.userId },
      });
      // N1 (Phase 5): every rejection opens exactly one Ncr for QC to disposition.
      await tx.ncr.create({ data: { assemblyStepRejectionId: rejection.id } });

      // S14 — was silent. QC is who dispositions an Ncr (S11's disposition
      // UI), same transaction as the ncr.create above (a failed notify rolls
      // back the whole reject).
      const qcIds = await userIdsWithRole(tx, actor.tenantId, ROLES.QC);
      if (qcIds.length > 0) {
        const ctx = await tx.assemblyStep.findUniqueOrThrow({
          where: { id: step.id },
          select: {
            templateStep: { select: { activity: true } },
            unit: { select: { serialNo: true, equipment: { select: { jobId: true, job: { select: { jobNumber: true } } } } } },
          },
        });
        await notify(
          tx,
          actor.tenantId,
          qcIds.map((recipientId) => ({
            recipientId,
            type: "NCR_OPENED",
            entityType: "AssemblyStep",
            entityId: step.id,
            title: `NCR opened: ${ctx.templateStep.activity}`,
            body: `${ctx.unit.equipment.job.jobNumber} · Unit ${ctx.unit.serialNo}`,
            payload: { jobId: ctx.unit.equipment.jobId, unitId: step.unitId },
          })),
        );
      }

      if (testTypeId != null && step.weldJointId != null) {
        const ndt = await recordNdtResultTx(tx, actor, step.weldJointId, testTypeId, "REJECT");
        // recordNdtResultTx itself is bare (no audited() wrapper, shared with
        // rejectAssemblyStep's other caller, recordNdtResult, which supplies
        // its own) — record this write's own audit row here so the "an NdtResult
        // was created" mutation is never silently un-audited (invariant #5).
        await recordAudit(tx, actor, {
          action: "welding.recordNdt",
          entityType: "NdtResult",
          entityId: ndt.id,
          after: { weldJointId: step.weldJointId, testTypeId, result: "REJECT" },
          eventType: "NdtResultRecorded",
          eventPayload: { ndtResultId: ndt.id, weldJointId: step.weldJointId, result: "REJECT" },
        });
      }
      // A4: mirror of verifyAssemblyStep's sync — a rejected INSPECTION step
      // is itself a QCP checkpoint result (REJECTED), not a silent no-op that
      // leaves the linked QcpItem looking untouched while the assembly view
      // shows real activity.
      if (step.templateStep.kind === "INSPECTION" && step.qcpItemId != null) {
        const exec = await recordQcpExecutionTx(tx, actor, {
          qcpItemId: step.qcpItemId,
          unitId: step.unitId,
          result: "REJECTED",
          remarks: detail ?? null,
        });
        await recordAudit(tx, actor, {
          action: "qcp.record",
          entityType: "QcpExecution",
          entityId: exec.id,
          after: { qcpItemId: step.qcpItemId, unitId: step.unitId, attemptNo: exec.attemptNo, result: "REJECTED" },
          eventType: "QcpExecutionRecorded",
          eventPayload: { qcpItemId: step.qcpItemId, unitId: step.unitId, attemptNo: exec.attemptNo, result: "REJECTED" },
        });
      }
      return {
        result: updated,
        audit: {
          action: "assemblyStep.reject",
          entityType: "AssemblyStep",
          entityId: step.id,
          before: { status: step.status, submittedBy: step.submittedBy },
          after: { status: updated.status, submittedBy: updated.submittedBy, categoryId, detail },
          eventType: "AssemblyStepRejected",
          eventPayload: {
            assemblyStepId: step.id,
            submittedBy: step.submittedBy,
            rejectedBy: actor.userId,
            categoryId,
            detail,
          },
        },
      };
    });
  });
}

/**
 * S17 (Gate 2): materialise AssemblyStep rows per Unit inside job-intake.
 * service.ts's createJob. Mirrors scripts/seed-despl320-assembly-steps.ts's
 * shape (idempotent-per-(unitId,seq) is moot here — createJob only ever
 * writes a brand-new job) but replaces its 0.5-threshold fuzzy text match on
 * the deliberately non-unique AssemblyTemplateStep.qcpSrNo with a
 * deterministic one: within the template's own step order and the job's own
 * QcpTemplate item order, the Nth step sharing a given srNo binds to the Nth
 * QcpItem sharing that srNo — verified exact (0 mismatches) against the real
 * PRESSURE_VESSEL template and QCP source data (seed/assembly-template-
 * pressure-vessel-v1.json vs seed/qcp-templates.json), which is what a
 * printed QCP's repeated sr-no rows actually mean: sequential checkpoints
 * for the same weld joint (edge prep, setup, weld, visual, NDT), authored in
 * the same order in both documents.
 *
 * Only INSPECTION-kind steps consume qcpItemId at all — assembly.service.ts's
 * own submit/reject paths only ever read it under `kind === "INSPECTION"`,
 * matching AssemblyStep.qcpItemId's own schema comment. WORK-kind steps are
 * gated by weldJointId instead (bound later, as the floor logs the joint),
 * so they're never even attempted here.
 *
 * Fails loudly (QCP_ITEM_UNRESOLVED) rather than leaving qcpItemId null when
 * an INSPECTION step's srNo has no matching occurrence in the job's own
 * QcpTemplate — CLAUDE.md's "do not guess" standard means an unresolvable
 * checkpoint is a real data problem (the chosen QCP template doesn't cover
 * this assembly template), not something to silently skip.
 */
export async function materializeAssemblyStepsFromTemplate(
  tx: Tx,
  tenantId: number,
  jobId: number,
  familyId: number,
  unitIds: number[],
  qcpTemplateId: number | null,
): Promise<{ stepCount: number; boundToQcp: number }> {
  if (unitIds.length === 0) return { stepCount: 0, boundToQcp: 0 };

  const asmTemplate = await tx.assemblyTemplate.findFirst({ where: { tenantId, familyId } });
  if (!asmTemplate) return { stepCount: 0, boundToQcp: 0 }; // no assembly template authored for this family yet — a legitimate seam

  const version = await tx.assemblyTemplateVersion.findFirst({
    where: { templateId: asmTemplate.id, status: "PUBLISHED" },
    orderBy: { version: "desc" },
    include: { steps: { orderBy: { seq: "asc" } } },
  });
  if (!version || version.steps.length === 0) return { stepCount: 0, boundToQcp: 0 };
  const steps = version.steps;

  // createJob is the only caller and always creates a brand-new Job, whose
  // assemblyTemplateVersionId is unconditionally null — no "already pinned,
  // don't re-pin" branch needed (unlike the seed script, which can also run
  // against an existing job).
  await tx.job.update({ where: { id: jobId }, data: { assemblyTemplateVersionId: version.id } });

  // Occurrence index of each step within its own srNo group, in template step order.
  const srNoOccurrence = new Map<number, number>(); // templateStepId -> 0-based index within its srNo group
  const srNoCounters = new Map<string, number>();
  for (const step of steps) {
    if (!step.srNo) continue;
    const idx = srNoCounters.get(step.srNo) ?? 0;
    srNoOccurrence.set(step.id, idx);
    srNoCounters.set(step.srNo, idx + 1);
  }

  const qcpItemsBySrNo = new Map<string, { id: number }[]>();
  if (qcpTemplateId != null) {
    const qcpItems = await tx.qcpItem.findMany({
      where: { qcpTemplateId },
      orderBy: { sequence: "asc" },
      select: { id: true, srNo: true },
    });
    for (const item of qcpItems) {
      const list = qcpItemsBySrNo.get(item.srNo) ?? [];
      list.push({ id: item.id });
      qcpItemsBySrNo.set(item.srNo, list);
    }
  }

  function resolveQcpItemId(step: (typeof steps)[number]): number | null {
    // No QCP template chosen at intake at all — a legitimate seam, not a failure to resolve.
    if (qcpTemplateId == null) return null;
    if (step.kind !== "INSPECTION" || !step.srNo) return null;
    const candidates = qcpItemsBySrNo.get(step.srNo);
    const idx = srNoOccurrence.get(step.id) ?? 0;
    const match = candidates?.[idx];
    if (!match) {
      throw new AppError(ERROR_CODES.QCP_ITEM_UNRESOLVED, {
        templateStepId: step.id,
        srNo: step.srNo,
        occurrence: idx,
        qcpTemplateId,
      });
    }
    return match.id;
  }

  let stepCount = 0;
  let boundToQcp = 0;
  const rows: { unitId: number; templateStepId: number; seq: number; qcpItemId: number | null }[] = [];
  for (const unitId of unitIds) {
    for (const step of steps) {
      const qcpItemId = resolveQcpItemId(step);
      if (qcpItemId != null) boundToQcp++;
      rows.push({ unitId, templateStepId: step.id, seq: step.seq, qcpItemId });
      stepCount++;
    }
  }
  await tx.assemblyStep.createMany({ data: rows });

  return { stepCount, boundToQcp };
}
