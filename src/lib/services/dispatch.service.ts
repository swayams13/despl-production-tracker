import { withTenant, type Tx } from "@/lib/db";
import { type Actor, assertNotClientUser, requireRole, ROLES } from "@/lib/authz";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { assertStateTransition } from "./state-machine";
import { assertUnitHasNoOpenHoldPoint, assertUnitHasNoOpenNcr, assertUnitProductionComplete } from "./_shared";
import {
  createDispatchBatchSchema,
  addUnitToBatchSchema,
  approveDispatchReleaseSchema,
  recordDispatchSchema,
  type CreateDispatchBatchInput,
  type AddUnitToBatchInput,
  type ApproveDispatchReleaseInput,
  type RecordDispatchInput,
} from "@/lib/shared/schemas";
import type { DispatchBatch, DispatchBatchUnit } from "@/generated/prisma/client";

/**
 * D2/D3 (Phase 5) — dispatch batches and the release/dispatch workflow.
 *
 * Controller ruling (task-5 brief correction): `DispatchBatch` has no
 * persisted `status` column, only nullable `releaseApprovedAt`/
 * `actualDispatchDate`. Rather than add a redundant enum column via
 * migration, status is DERIVED from those fields and validated through the
 * same `assertStateTransition` every other state machine in this codebase
 * uses (see component.service.ts's `assertComponentOpTransition`,
 * ncr.service.ts's `assertNcrTransition`) — so an illegal transition (e.g.
 * `recordDispatch` before `approveDispatchRelease`) still refuses with
 * INVALID_STATE_TRANSITION, without a second source of truth to drift from
 * the nullable fields.
 */

export type DispatchBatchStatus = "PLANNED" | "RELEASED" | "DISPATCHED";
export type DispatchBatchAction = "approveRelease" | "recordDispatch";

export const DISPATCH_BATCH_TRANSITIONS: Record<
  DispatchBatchAction,
  { from: DispatchBatchStatus[]; to: DispatchBatchStatus }
> = {
  approveRelease: { from: ["PLANNED"], to: "RELEASED" },
  recordDispatch: { from: ["RELEASED"], to: "DISPATCHED" },
};

export function deriveDispatchBatchStatus(batch: {
  releaseApprovedAt: Date | null;
  actualDispatchDate: Date | null;
}): DispatchBatchStatus {
  if (batch.actualDispatchDate != null) return "DISPATCHED";
  if (batch.releaseApprovedAt != null) return "RELEASED";
  return "PLANNED";
}

export function assertDispatchBatchTransition(
  action: DispatchBatchAction,
  from: DispatchBatchStatus,
): DispatchBatchStatus {
  return assertStateTransition(DISPATCH_BATCH_TRANSITIONS, action, from, "DispatchBatch");
}

async function lockDispatchBatchForUpdate(tx: Tx, dispatchBatchId: number, tenantId: number): Promise<DispatchBatch> {
  await tx.$queryRaw`SELECT id FROM dispatch_batches WHERE id = ${dispatchBatchId} FOR UPDATE`;

  const batch = await tx.dispatchBatch.findFirst({ where: { id: dispatchBatchId, job: { tenantId } } });
  if (!batch) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "DispatchBatch", dispatchBatchId });
  return batch;
}

export async function createDispatchBatch(actor: Actor, input: CreateDispatchBatchInput): Promise<DispatchBatch> {
  const { jobId, seq, plannedDate, remarks } = createDispatchBatchSchema.parse(input);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findFirst({ where: { id: jobId, tenantId: actor.tenantId } });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });

    return audited(tx, actor, async () => {
      const batch = await tx.dispatchBatch.create({
        data: { jobId, seq, plannedDate, remarks: remarks ?? null },
      });
      return {
        result: batch,
        audit: {
          action: "dispatchBatch.create",
          entityType: "DispatchBatch",
          entityId: batch.id,
          after: { jobId: batch.jobId, seq: batch.seq, plannedDate: batch.plannedDate },
          eventType: "DispatchBatchCreated",
          eventPayload: { dispatchBatchId: batch.id, jobId },
        },
      };
    });
  });
}

/**
 * Adds a unit to a batch. Requires the unit's `packageId` to already be set
 * (a distinct, unit-grain precondition from Task 6's process-level
 * PACKING_DONE evidence gate) — refuses with UNIT_NOT_PACKED otherwise.
 *
 * Also refuses (packing.service.ts's `assignUnitToPackage` precedent):
 *  - a unit whose job doesn't match the batch's job (CROSS_JOB_ASSIGNMENT)
 *  - adding to a batch that's no longer PLANNED (RELEASED/DISPATCHED) — once
 *    released/dispatched, the unit set is the approved/shipped set; adding a
 *    unit after the fact would retroactively satisfy Task 6's
 *    DISPATCH_RECORDED evidence gate for a unit that was never actually part
 *    of it.
 */
export async function addUnitToBatch(actor: Actor, input: AddUnitToBatchInput): Promise<DispatchBatchUnit> {
  const { dispatchBatchId, unitId } = addUnitToBatchSchema.parse(input);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const batch = await lockDispatchBatchForUpdate(tx, dispatchBatchId, actor.tenantId);

    if (deriveDispatchBatchStatus(batch) !== "PLANNED") {
      throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, {
        entity: "DispatchBatch",
        dispatchBatchId: batch.id,
        status: deriveDispatchBatchStatus(batch),
        action: "addUnit",
      });
    }

    const unit = await tx.unit.findFirst({
      where: { id: unitId, equipment: { job: { tenantId: actor.tenantId } } },
      include: { equipment: { select: { jobId: true } } },
    });
    if (!unit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Unit", unitId });

    if (unit.equipment.jobId !== batch.jobId) {
      throw new AppError(ERROR_CODES.CROSS_JOB_ASSIGNMENT, {
        unitId,
        unitJobId: unit.equipment.jobId,
        dispatchBatchId: batch.id,
        dispatchBatchJobId: batch.jobId,
      });
    }

    if (unit.packageId == null) {
      throw new AppError(ERROR_CODES.UNIT_NOT_PACKED, { unitId });
    }

    // S10 — same reverse quality gate as packing.service.ts's
    // assignUnitToPackage: a unit already packed clean could develop an NCR
    // (or a checkpoint could reopen) before it's ever added to a batch, so
    // this is a genuinely separate check, not a redundant re-run of
    // packing's own gate.
    await assertUnitHasNoOpenHoldPoint(tx, unit.id, unit.equipment.jobId);
    await assertUnitHasNoOpenNcr(tx, unit.id, unit.equipment.jobId);

    return audited(tx, actor, async () => {
      const link = await tx.dispatchBatchUnit.create({
        data: { dispatchBatchId: batch.id, unitId: unit.id, jobId: batch.jobId },
      });
      return {
        result: link,
        audit: {
          action: "dispatchBatch.addUnit",
          entityType: "DispatchBatchUnit",
          entityId: link.id,
          after: { dispatchBatchId: batch.id, unitId: unit.id },
          eventType: "UnitAddedToDispatchBatch",
          eventPayload: { dispatchBatchId: batch.id, unitId: unit.id },
        },
      };
    });
  });
}

/**
 * Production-Head-only release approval (same role gate as
 * override.service.ts's applyDurationOverride). Requires derived status
 * PLANNED; stamps releaseApprovedBy/releaseApprovedAt server-side.
 */
export async function approveDispatchRelease(
  actor: Actor,
  input: ApproveDispatchReleaseInput,
): Promise<DispatchBatch> {
  const { dispatchBatchId, dispatchNoteNo, gatePassNo, vehicleNo, lrNo } = approveDispatchReleaseSchema.parse(input);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const batch = await lockDispatchBatchForUpdate(tx, dispatchBatchId, actor.tenantId);
    assertDispatchBatchTransition("approveRelease", deriveDispatchBatchStatus(batch));

    // AUD-005 — addUnitToBatch's gate ran at batching time; a unit's quality
    // state and production completeness are both mutable after that (an NCR
    // can open, a hold point can flip, days can pass before release), so
    // this is a genuinely separate re-check, not a redundant re-run.
    const links = await tx.dispatchBatchUnit.findMany({
      where: { dispatchBatchId: batch.id },
      select: { unitId: true },
    });
    for (const { unitId } of links) {
      await assertUnitHasNoOpenHoldPoint(tx, unitId, batch.jobId);
      await assertUnitHasNoOpenNcr(tx, unitId, batch.jobId);
      await assertUnitProductionComplete(tx, unitId, batch.jobId);
    }

    return audited(tx, actor, async () => {
      const now = new Date();
      const updated = await tx.dispatchBatch.update({
        where: { id: batch.id },
        data: {
          dispatchNoteNo: dispatchNoteNo ?? undefined,
          gatePassNo: gatePassNo ?? undefined,
          vehicleNo: vehicleNo ?? undefined,
          lrNo: lrNo ?? undefined,
          releaseApprovedBy: actor.userId,
          releaseApprovedAt: now,
        },
      });
      return {
        result: updated,
        audit: {
          action: "dispatchBatch.approveRelease",
          entityType: "DispatchBatch",
          entityId: batch.id,
          before: { releaseApprovedAt: batch.releaseApprovedAt },
          after: {
            releaseApprovedBy: updated.releaseApprovedBy,
            releaseApprovedAt: updated.releaseApprovedAt,
            dispatchNoteNo: updated.dispatchNoteNo,
            gatePassNo: updated.gatePassNo,
            vehicleNo: updated.vehicleNo,
            lrNo: updated.lrNo,
          },
          eventType: "DispatchReleaseApproved",
          eventPayload: { dispatchBatchId: batch.id, releaseApprovedBy: actor.userId },
        },
      };
    });
  });
}

/**
 * Requires derived status RELEASED; stamps `actualDispatchDate = now()`
 * server-side (invariant #1 — recordDispatchSchema has no such field, so a
 * client-supplied date can never reach here). Also satisfies Task 6's
 * DISPATCH_RECORDED evidence kind for every unit in the batch (read side —
 * no write needed here beyond this stamp).
 */
export async function recordDispatch(actor: Actor, input: RecordDispatchInput): Promise<DispatchBatch> {
  const { dispatchBatchId } = recordDispatchSchema.parse(input);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const batch = await lockDispatchBatchForUpdate(tx, dispatchBatchId, actor.tenantId);
    assertDispatchBatchTransition("recordDispatch", deriveDispatchBatchStatus(batch));

    // AUD-005 — re-checked independently of approveDispatchRelease's own
    // re-check: a unit released clean can still develop an open NCR, an
    // uncleared hold point, or an incomplete ProcessPlan before the physical
    // dispatch actually happens, and this is the last gate standing between
    // that unit and a dispatch note/gate pass/LR number.
    const links = await tx.dispatchBatchUnit.findMany({
      where: { dispatchBatchId: batch.id },
      select: { unitId: true },
    });
    for (const { unitId } of links) {
      await assertUnitHasNoOpenHoldPoint(tx, unitId, batch.jobId);
      await assertUnitHasNoOpenNcr(tx, unitId, batch.jobId);
      await assertUnitProductionComplete(tx, unitId, batch.jobId);
    }

    return audited(tx, actor, async () => {
      const now = new Date();
      const updated = await tx.dispatchBatch.update({
        where: { id: batch.id },
        data: { actualDispatchDate: now },
      });
      return {
        result: updated,
        audit: {
          action: "dispatchBatch.recordDispatch",
          entityType: "DispatchBatch",
          entityId: batch.id,
          before: { actualDispatchDate: batch.actualDispatchDate },
          after: { actualDispatchDate: updated.actualDispatchDate },
          eventType: "DispatchRecorded",
          eventPayload: { dispatchBatchId: batch.id },
        },
      };
    });
  });
}
