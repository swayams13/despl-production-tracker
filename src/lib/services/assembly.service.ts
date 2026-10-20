import { withTenant, type Tx } from "@/lib/db";
import { type Actor, assertMakerChecker, assertNotClientUser, requireDepartmentScope, ROLES } from "@/lib/authz";
import { audited, recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { deriveRequiresQc, jointRefs, requiredJointRef } from "@/lib/shared/floor-rules";
import { GENERATED_JOINT_TYPES, generateShellJoints, MAX_SHELL_COURSES } from "@/lib/shared/joint-generator";
import { FEATURES } from "@/lib/shared/flags";
import { assertStateTransition } from "./state-machine";
import { assertPerformedByValid, createWeldJointTx, recordNdtResultTx } from "./welding.service";
import { closeNcr, closeRuleNcrsOnRedo } from "./ncr.service";
import { lockFloorUnits, rollupForAssemblyStep } from "./_shared";
import { assertFloorHard } from "./work.facts";
import { resolveAssemblyTemplateVersion } from "./assembly-template.resolve";
import type { LineRules } from "./config-rules";
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
import type { AssemblyStep, AssemblyStepRole, OperationStatus } from "@/generated/prisma/client";

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

type LockedStep = AssemblyStep & {
  templateStep: { seq: number; defaultDepartmentId: number; kind: string; jointRef: string | null; scope: string; groupCode: string };
};

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
  opts: { unitLock?: boolean } = {},
): Promise<{
  step: LockedStep;
  previousStep: { seq: number; status: OperationStatus } | null;
}> {
  if (opts.unitLock) {
    // L1.2e: the unit's floor lock goes BEFORE the row lock, as in recordWork.
    const pre = await tx.assemblyStep.findFirst({
      where: { id: assemblyStepId, unit: { equipment: { job: { tenantId } } } },
      select: { jobId: true, unitId: true },
    });
    if (pre) await lockFloorUnits(tx, pre.jobId, [pre.unitId]);
  }
  await tx.$queryRaw`SELECT id FROM assembly_steps WHERE id = ${assemblyStepId} FOR UPDATE`;

  const step = await tx.assemblyStep.findFirst({
    where: { id: assemblyStepId, unit: { equipment: { job: { tenantId } } } },
    include: {
      templateStep: { select: { seq: true, defaultDepartmentId: true, kind: true, jointRef: true, scope: true, groupCode: true } },
    },
  });
  if (!step) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "AssemblyStep", assemblyStepId });
  // H1 job-level RLS backstop: scope every subsequent query in THIS transaction
  // to the step's own (denormalized) job — same pattern as
  // lockProcessPlanForUpdate in _shared.ts.
  await tx.$executeRaw`SELECT set_config('app.job_id', ${String(step.jobId)}, true)`;

  const previousStep =
    step.seq > 1
      ? await tx.assemblyStep.findFirst({
          // J4a: by the row's own seq. It equals the template seq until a scoped step expands.
          where: { unitId: step.unitId, seq: step.seq - 1 },
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
    const lean = FEATURES.leanFloor;
    const { step, previousStep } = await lockAssemblyStepForUpdate(tx, assemblyStepId, actor.tenantId, { unitLock: lean });
    requireDepartmentScope(actor, step.templateStep.defaultDepartmentId);
    const to = assertAssemblyStepTransition("start", step.status);
    // Review fix: with the lean floor on, the D2 HARD rules hold on this path too.
    if (lean) await assertFloorHard(tx, "ASSEMBLY_STEP", step.id, "START");

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

    const started = await audited(tx, actor, async () => {
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
    // L1.2e: starting the first mapped step moves a derived plan to IN_PROGRESS.
    if (FEATURES.leanFloor) await rollupForAssemblyStep(tx, actor, started.id);
    return started;
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
    const lean = FEATURES.leanFloor;
    const { step } = await lockAssemblyStepForUpdate(tx, assemblyStepId, actor.tenantId, { unitLock: lean });
    requireDepartmentScope(actor, step.templateStep.defaultDepartmentId);
    const to = assertAssemblyStepTransition("submit", step.status);
    if (lean) await assertFloorHard(tx, "ASSEMBLY_STEP", step.id, "DONE");

    // J4a: a row expanded for a planned joint names its joint on the row itself (its template step has no literal jointRef).
    const stepJointRef = requiredJointRef(step);
    if (stepJointRef != null && weldJointId == null && newJoint == null && step.weldJointId == null) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { assemblyStepId, jointRef: stepJointRef },
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
        // J4a: a row expanded for a planned joint logs that joint, under its number; a literal step is as before.
        const joint = await createWeldJointTx(
          tx,
          actor,
          equipment.jobId,
          step.unitId,
          null,
          step.plannedJointId != null && step.jointRef ? { ...newJoint, jointNo: step.jointRef } : newJoint,
          step.plannedJointId,
        );
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
    const updated = await verifyAssemblyStepTx(tx, actor, assemblyStepId);
    // L1.2e: with the lean floor on, a mapped plan takes its status from its steps.
    if (FEATURES.leanFloor) await rollupForAssemblyStep(tx, actor, updated.id);
    return updated;
  });
}

/** verifyAssemblyStep's body for a caller that already holds the transaction. */
export async function verifyAssemblyStepTx(tx: Tx, actor: Actor, assemblyStepId: number): Promise<AssemblyStep> {
  const { step } = await lockAssemblyStepForUpdate(tx, assemblyStepId, actor.tenantId);
  assertMakerChecker(actor, step.submittedBy);
  const to = assertAssemblyStepTransition("verify", step.status);
  return completeStepLocked(tx, actor, step, to);
}

/** Everything verify does once the row is locked and the maker–checker and transition checks have passed. */
async function completeStepLocked(tx: Tx, actor: Actor, step: LockedStep, to: OperationStatus): Promise<AssemblyStep> {
  // N1 (Phase 5): re-verifying a reworked step closes its open Ncr(s) and
  // records the elapsed rework time. findMany, not findFirst — see the
  // matching comment in component.service.ts's verifyComponentOperation
  // (task review Critical #1): repeated reject→resubmit→reject cycles can
  // leave more than one Ncr open for the same step.
  //
  // AUD-026: an Ncr still OPEN was never dispositioned — closing it here
  // would skip dispositionNcr entirely and record no engineering decision.
  // Refuse before touching anything if any linked Ncr is still OPEN; only
  // DISPOSITIONED/REWORK_IN_PROGRESS ones are eligible to close.
  const undispositioned = await tx.ncr.count({
    where: { status: "OPEN", assemblyStepRejection: { assemblyStepId: step.id } },
  });
  if (undispositioned > 0) {
    throw new AppError(ERROR_CODES.NCR_NOT_DISPOSITIONED, { assemblyStepId: step.id, undispositioned });
  }
  const openNcrs = await tx.ncr.findMany({
    where: { status: { in: ["DISPOSITIONED", "REWORK_IN_PROGRESS"] }, assemblyStepRejection: { assemblyStepId: step.id } },
  });

  return audited(tx, actor, async () => {
    // One instant for both stamps: two new Date() calls could straddle a millisecond and trip
    // assembly_steps_finish_after_start on a step completed straight from NOT_STARTED.
    const now = new Date();
    const updated = await tx.assemblyStep.update({
      where: { id: step.id },
      data: {
        status: to,
        finishedAt: now,
        verifiedBy: actor.userId,
        ...(step.startedAt == null ? { startedAt: now } : {}),
      },
    });
    for (const ncr of openNcrs) {
      await closeNcr(tx, actor, { ncrId: ncr.id, jobId: ncr.jobId });
    }
    // L1.2f: a repeated final PWHT / hydro closes the unit's H5/H6 NCRs under repair.
    await closeRuleNcrsOnRedo(tx, actor, updated);
    // A4: an INSPECTION step verifying IS the QCP checkpoint result — record
    // it so assertNoOpenHoldPoint and the QCP/hold-point view see the same
    // truth the assembly view just showed, instead of the linked QcpItem
    // staying stuck PENDING forever (verify already proved QC role + not
    // the submitter, via assertMakerChecker above).
    if (step.templateStep.kind === "INSPECTION" && step.qcpItemId != null) {
      // AUD-004: an internal DESPL employee verifying this step must not
      // manufacture evidence that a THIRD PARTY (client TPI, buyer TPI,
      // EIL TPIA, ...) witnessed something they were never actually
      // present for — assertMakerChecker above only proves two different
      // internal humans were involved, it says nothing about an external
      // inspector. InspectionParty.code has no boolean "is this internal"
      // column; the real marker used by every seeded QCP template is
      // InspectionParty.code === the tenant's own Organization.code (see
      // seed/qcp-templates.json's observedPartySets, where "DESPL" is the
      // party code and matches Organization.code exactly). If any BLOCKING
      // party code on this checkpoint belongs to a party other than that,
      // skip the auto-record entirely — leave the checkpoint exactly as it
      // is (no execution row, still open per assertNoOpenHoldPoint) until
      // someone records it for real via recordQcpExecution.
      const partyCodes = await tx.qcpItemPartyCode.findMany({
        where: { qcpItemId: step.qcpItemId },
        select: { qcpCode: { select: { blocksCompletion: true } }, inspectionParty: { select: { code: true } } },
      });
      const org = await tx.organization.findUnique({ where: { id: actor.tenantId }, select: { code: true } });
      const externalBlocking = partyCodes.some(
        (pc) => pc.qcpCode.blocksCompletion && pc.inspectionParty.code !== org?.code,
      );
      // J4a: several rows of one unit can share a checkpoint (a PER_JOINT inspection expands per
      // joint). It is cleared only when the last of them is complete; until then the hold stays
      // open. A REJECT still records at once (latest wins), so one bad joint re-opens it.
      const openSiblings = await tx.assemblyStep.count({
        where: { unitId: step.unitId, qcpItemId: step.qcpItemId, id: { not: step.id }, status: { not: "COMPLETE" } },
      });
      if (!externalBlocking && openSiblings === 0) {
        const exec = await recordQcpExecutionTx(tx, actor, {
          qcpItemId: step.qcpItemId,
          unitId: step.unitId,
          result: "ACCEPTED",
          jobId: step.jobId,
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
  const parsed = rejectAssemblyStepSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const updated = await rejectAssemblyStepTx(tx, actor, parsed);
    if (FEATURES.leanFloor) await rollupForAssemblyStep(tx, actor, updated.id);
    return updated;
  });
}

/**
 * rejectAssemblyStep's body for a caller that already holds the transaction.
 * L1.2e: takes the unit's floor lock before the row lock (recordWork's order),
 * so a reject and a concurrent Start/Done batch on the unit serialise.
 */
export async function rejectAssemblyStepTx(tx: Tx, actor: Actor, input: RejectAssemblyStepInput): Promise<AssemblyStep> {
  const { step } = await lockAssemblyStepForUpdate(tx, input.assemblyStepId, actor.tenantId, { unitLock: true });
  assertMakerChecker(actor, step.submittedBy);
  const to = assertAssemblyStepTransition("reject", step.status);
  return rejectStepLocked(tx, actor, step, to, input);
}

async function rejectStepLocked(
  tx: Tx,
  actor: Actor,
  step: LockedStep,
  to: OperationStatus,
  { assemblyStepId, categoryId, detail, testTypeId }: RejectAssemblyStepInput,
): Promise<AssemblyStep> {
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
      data: { status: to, submittedBy: null, ...(step.startedAt == null ? { startedAt: new Date() } : {}) },
    });
    const rejection = await tx.assemblyStepRejection.create({
      data: { assemblyStepId: step.id, categoryId, detail: detail ?? null, rejectedBy: actor.userId, jobId: step.jobId },
    });
    // N1 (Phase 5): every rejection opens exactly one Ncr for QC to disposition.
    await tx.ncr.create({ data: { assemblyStepRejectionId: rejection.id, jobId: step.jobId } });

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
        jobId: step.jobId,
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
}

/**
 * Lean Core L1.2e: QC accepts or rejects a step, in the caller's transaction.
 * A SUBMITTED step goes through the same verify/reject bodies as the legacy
 * paths. An INSPECTION-kind step is never submitted by anyone (recordWork
 * refuses it with INSPECT_REQUIRED), so QC's accept completes it directly from
 * NOT_STARTED / IN_PROGRESS, and a reject opens its rejection + NCR and leaves
 * it IN_PROGRESS for re-inspection. Maker–checker (invariant 3): QC role, not
 * the submitter, and for an INSPECTION step not whoever recorded or performed
 * ANY preceding WORK step of the same template group (same joint where the
 * step names one); with no such step there is no maker and it refuses. ACCEPT
 * and REJECT of an INSPECTION step also need every one of those steps SUBMITTED or
 * COMPLETE (INSPECT_PRECONDITION). No Production Head exception until D11 is
 * decided.
 */
export async function inspectAssemblyStepTx(
  tx: Tx,
  actor: Actor,
  args: { assemblyStepId: number; result: "ACCEPT" | "REJECT"; reason?: string; categoryId: number; testTypeId?: number },
): Promise<{ from: OperationStatus; step: AssemblyStep }> {
  const { step } = await lockAssemblyStepForUpdate(tx, args.assemblyStepId, actor.tenantId, { unitLock: true });
  assertMakerChecker(actor, step.submittedBy);
  const inspection = step.templateStep.kind === "INSPECTION";
  if (inspection) {
    // The makers: every preceding WORK step of the template group, on the same joint where one is set (H1 scope).
    const group = await tx.assemblyStep.findMany({
      where: { unitId: step.unitId, seq: { lt: step.seq }, templateStep: { kind: "WORK", groupCode: step.templateStep.groupCode } },
      select: { id: true, status: true, submittedBy: true, performedByUserId: true, jointRef: true },
    });
    const own = jointRefs(step.jointRef);
    const makers = own.length ? group.filter((s) => jointRefs(s.jointRef).some((j) => own.includes(j))) : group;
    if (makers.length === 0) {
      throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { reason: "no preceding work step to inspect", assemblyStepId: step.id });
    }
    const mine = makers.find((m) => m.submittedBy === actor.userId || m.performedByUserId === actor.userId);
    if (mine) {
      throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { reason: "recorded a preceding work step", precedingStepId: mine.id });
    }
    const open = makers.filter((m) => m.status !== "SUBMITTED" && m.status !== "COMPLETE");
    // Decision 6 (14 Oct): REJECT too. QC cannot open an NCR against work that was never recorded.
    if (open.length > 0) {
      throw new AppError(ERROR_CODES.INSPECT_PRECONDITION, { assemblyStepId: step.id, openStepIds: open.map((m) => m.id) });
    }
  }

  const accept = args.result === "ACCEPT";
  const direct = inspection && (step.status === "NOT_STARTED" || step.status === "IN_PROGRESS");
  const to: OperationStatus = direct
    ? accept
      ? "COMPLETE"
      : "IN_PROGRESS"
    : assertAssemblyStepTransition(accept ? "verify" : "reject", step.status);
  const updated = accept
    ? await completeStepLocked(tx, actor, step, to)
    : await rejectStepLocked(tx, actor, step, to, {
        assemblyStepId: step.id,
        categoryId: args.categoryId,
        detail: args.reason,
        testTypeId: args.testTypeId,
      });
  return { from: step.status, step: updated };
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
  equipmentTypeId: number | null = null,
  /** J2: this line's answers. Absent = no rules evaluated (every step materialised, as before). */
  rules: LineRules | null = null,
  /** J2: QCP source items a rule dropped; their position still counts when steps bind to items. */
  skippedQcp: { srNo: string; sequence: number }[] = [],
  /** J3a: the line these units belong to; it records the assembly template version its steps came from. */
  equipmentId: number | null = null,
  /** J4a: the line's answers (shell_courses plans its seams when the route has PER_JOINT steps). */
  answers: Record<string, unknown> = {},
): Promise<{ stepCount: number; boundToQcp: number }> {
  if (unitIds.length === 0) return { stepCount: 0, boundToQcp: 0 };

  // No assembly template authored for this family yet is a legitimate seam.
  const version = await resolveAssemblyTemplateVersion(tx, tenantId, familyId, equipmentTypeId);
  if (!version) return { stepCount: 0, boundToQcp: 0 };
  if (equipmentId != null) {
    await tx.equipment.update({ where: { id: equipmentId }, data: { assemblyTemplateVersionId: version.id } });
  }
  // Occurrence indices below are counted over the FULL template, so a rule that
  // drops one step never shifts which QCP item the later steps bind to (J2).
  const allSteps = version.steps;
  const steps = rules ? allSteps.filter((st) => rules.decide("ASSEMBLY_STEP", st.id, st.includeWhen)) : allSteps;
  if (steps.length === 0) return { stepCount: 0, boundToQcp: 0 };

  // createJob only ever writes a brand-new Job, so the pin starts null. A job
  // with several equipment blocks calls this once per block: the first block's
  // version stays the job-level pin (J3 makes it per-equipment), later calls
  // must not overwrite it.
  await tx.job.updateMany({ where: { id: jobId, assemblyTemplateVersionId: null }, data: { assemblyTemplateVersionId: version.id } });

  // Occurrence index of each step within its own srNo group, in template step order.
  const srNoOccurrence = new Map<number, number>(); // templateStepId -> 0-based index within its srNo group
  const srNoCounters = new Map<string, number>();
  for (const step of allSteps) {
    if (!step.srNo) continue;
    const idx = srNoCounters.get(step.srNo) ?? 0;
    srNoOccurrence.set(step.id, idx);
    srNoCounters.set(step.srNo, idx + 1);
  }

  // id null = a checkpoint a rule dropped from the job's QCP; it keeps its place in the order.
  const qcpItemsBySrNo = new Map<string, { id: number | null; sequence: number }[]>();
  if (qcpTemplateId != null) {
    const qcpItems = await tx.qcpItem.findMany({
      where: { qcpTemplateId },
      select: { id: true, srNo: true, sequence: true },
    });
    const all = [
      ...qcpItems.map((q) => ({ id: q.id as number | null, srNo: q.srNo, sequence: q.sequence })),
      ...skippedQcp.map((q) => ({ id: null, srNo: q.srNo, sequence: q.sequence })),
    ].sort((a, b) => a.sequence - b.sequence);
    for (const item of all) {
      const list = qcpItemsBySrNo.get(item.srNo) ?? [];
      list.push({ id: item.id, sequence: item.sequence });
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
    if (!match || match.id == null) {
      throw new AppError(ERROR_CODES.QCP_ITEM_UNRESOLVED, {
        templateStepId: step.id,
        srNo: step.srNo,
        occurrence: idx,
        qcpTemplateId,
        ...(match && match.id == null ? { droppedByRule: true } : {}),
      });
    }
    return match.id;
  }

  // J4a: PER_JOINT steps expand per planned joint of their type, PER_COMPONENT per component.
  // The seams a shell implies are generated here from the line's answer when the line has
  // none yet; any other joint type (nozzle, attachment) has to be on the weld map already.
  let joints: { id: number; jointNo: string; jointType: string }[] = [];
  if (equipmentId != null) {
    joints = await tx.plannedJoint.findMany({
      where: { equipmentId },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { id: true, jointNo: true, jointType: true },
    });
  }
  const jointTypesNeeded = [...new Set(steps.filter((st) => st.scope === "PER_JOINT").map((st) => st.jointType!))];
  const toGenerate = jointTypesNeeded.filter(
    (t) => (GENERATED_JOINT_TYPES as readonly string[]).includes(t) && !joints.some((j) => j.jointType === t),
  );
  if (toGenerate.length > 0) {
    const courses = answers.shell_courses;
    if (equipmentId == null || typeof courses !== "number" || !Number.isInteger(courses) || courses < 1 || courses > MAX_SHELL_COURSES) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { answerKey: "shell_courses", jointTypes: toGenerate },
        "This route has welds that follow the shell courses. Enter the number of shell courses (1 to 30) so the long and circumferential seams can be planned.",
      );
    }
    await tx.plannedJoint.createMany({
      data: generateShellJoints(courses)
        .filter((j) => toGenerate.includes(j.jointType))
        .map((j) => ({ jobId, equipmentId, jointNo: j.jointNo, jointType: j.jointType, joins: j.joins, sortOrder: j.sortOrder, source: "GENERATED" as const })),
    });
    joints = await tx.plannedJoint.findMany({
      where: { equipmentId },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { id: true, jointNo: true, jointType: true },
    });
  }
  const componentTypeIds = [...new Set(steps.filter((st) => st.scope === "PER_COMPONENT").map((st) => st.componentTypeId!))];
  const componentsByUnit = new Map<number, { id: number; componentTypeId: number }[]>();
  if (componentTypeIds.length > 0) {
    const comps = await tx.component.findMany({
      where: { unitId: { in: unitIds }, componentTypeId: { in: componentTypeIds } },
      orderBy: { id: "asc" },
      select: { id: true, unitId: true, componentTypeId: true },
    });
    for (const c of comps) {
      if (c.unitId == null) continue;
      componentsByUnit.set(c.unitId, [...(componentsByUnit.get(c.unitId) ?? []), { id: c.id, componentTypeId: c.componentTypeId! }]);
    }
  }

  let stepCount = 0;
  let boundToQcp = 0;
  const rows: {
    unitId: number;
    templateStepId: number;
    seq: number;
    qcpItemId: number | null;
    requiresQc: boolean;
    role: AssemblyStepRole | null;
    jointRef: string | null;
    pressurePart: boolean;
    plannedJointId: number | null;
    componentId: number | null;
    jobId: number;
  }[] = [];
  for (const unitId of unitIds) {
    // Rows an expansion adds shift every later template step by that many seqs (a step that
    // expands to nothing leaves a gap). A route with no scoped step is unchanged: extra stays 0.
    let extra = 0;
    for (const step of steps) {
      const targets: { plannedJointId: number | null; componentId: number | null; jointRef: string | null }[] =
        step.scope === "PER_JOINT"
          ? joints.filter((j) => j.jointType === step.jointType).map((j) => ({ plannedJointId: j.id, componentId: null, jointRef: j.jointNo }))
          : step.scope === "PER_COMPONENT"
            ? (componentsByUnit.get(unitId) ?? [])
                .filter((c) => c.componentTypeId === step.componentTypeId)
                .map((c) => ({ plannedJointId: null, componentId: c.id, jointRef: step.jointRef }))
            : [{ plannedJointId: null, componentId: null, jointRef: step.jointRef }];
      for (const [i, target] of targets.entries()) {
        const qcpItemId = resolveQcpItemId(step);
        if (qcpItemId != null) boundToQcp++;
        // Lean Core L1.1 (D3) / L1.2 (D2): copied at intake, like grain/enforcement;
        // the floor rules read the job row, never the template.
        rows.push({
          unitId,
          templateStepId: step.id,
          seq: step.seq + extra + i,
          qcpItemId,
          // D3 (L1.2c): derived by rule only where the template step carries a
          // role (reviewed facts); a role-less step keeps the template value.
          // Either level can waive QC, hence the AND.
          requiresQc:
            step.requiresQc &&
            (!step.role ||
              deriveRequiresQc({
                kind: "ASSEMBLY_STEP",
                stepKind: step.kind,
                role: step.role,
                qcpLinked: qcpItemId != null,
                pressure: step.pressurePart,
              }).requiresQc),
          role: step.role,
          jointRef: target.jointRef,
          pressurePart: step.pressurePart,
          plannedJointId: target.plannedJointId,
          componentId: target.componentId,
          jobId,
        });
        stepCount++;
      }
      extra += Math.max(targets.length - 1, 0);
    }
  }
  await tx.assemblyStep.createMany({ data: rows });

  return { stepCount, boundToQcp };
}
