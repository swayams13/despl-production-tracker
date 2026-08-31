import { withTenant, type Tx } from "@/lib/db";
import { type Actor, assertMakerChecker, assertNotClientUser, requireDepartmentScope } from "@/lib/authz";
import { audited, recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { assertStateTransition } from "./state-machine";
import { assertPerformedByValid, createWeldJointTx, recordNdtResultTx } from "./welding.service";
import { closeNcr } from "./ncr.service";
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
