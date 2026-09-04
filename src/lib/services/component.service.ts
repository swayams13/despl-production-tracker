import { withTenant, type Tx } from "@/lib/db";
import { type Actor, assertMakerChecker, assertNotClientUser, requireDepartmentScope, ROLES } from "@/lib/authz";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { assertKitReady, assertDrawingReleased } from "./_shared";
import { assertStateTransition } from "./state-machine";
import { assertPerformedByValid } from "./welding.service";
import { closeNcr } from "./ncr.service";
import { notify, userIdsWithRole } from "./notifications.service";
import {
  startComponentOperationSchema,
  submitComponentOperationSchema,
  verifyComponentOperationSchema,
  rejectComponentOperationSchema,
  recordPaintRecordSchema,
  recordDftReadingSchema,
  type StartComponentOperationInput,
  type SubmitComponentOperationInput,
  type VerifyComponentOperationInput,
  type RejectComponentOperationInput,
  type RecordPaintRecordInput,
  type RecordDftReadingInput,
} from "@/lib/shared/schemas";
import type { ComponentOperation, DftReading, OperationStatus, PaintRecord } from "@/generated/prisma/client";

/** P1 (Phase 5): a PAINTING op's coats requirement — 1 if unset. */
const DEFAULT_COATS_REQUIRED = 1;

/**
 * Wired into Server Actions (`src/app/actions/component.ts`) and the
 * BomPanel UI (`src/components/industrial/bom-panel.tsx`). Mirrors
 * src/lib/services/process.service.ts's state machine and invariant gates as
 * closely as the two entities' shapes allow (CLAUDE.md #1/#2/#3/#5/#8/#12).
 *
 * Grain: ComponentOperation is the per-part fabrication step (Shell rolling,
 * forming, cutting, welding, NDT, inspection, ...) — this is the
 * "sub-assembly" tracker. It's deliberately simpler than ProcessPlan's state
 * machine: no HOLD/resume, and no cross-component DAG — a component's own
 * route is a flat ordered sequence (RouteStep.seq), so the only ordering
 * gate is "the previous seq on THIS component must be COMPLETE", not a full
 * predecessor graph. F5 (Phase 1): reject() returns a SUBMITTED op to
 * IN_PROGRESS with the rejection retained in `ComponentOperationRejection`
 * (reuses `DelayCategoryRef`, the same taxonomy `DelayReason` uses at process
 * grain) — the durable home the earlier draft of this file said didn't exist
 * yet.
 */

export type ComponentOperationAction = "start" | "submit" | "verify" | "reject";

export const COMPONENT_OP_TRANSITIONS: Record<
  ComponentOperationAction,
  { from: OperationStatus[]; to: OperationStatus }
> = {
  start: { from: ["NOT_STARTED"], to: "IN_PROGRESS" },
  submit: { from: ["IN_PROGRESS"], to: "SUBMITTED" },
  verify: { from: ["SUBMITTED"], to: "COMPLETE" },
  // F5 / F-e (spec §4): rejected work restarts from the SAME step, not an
  // earlier one — the floor has not been asked to confirm otherwise, and
  // this is the addendum's own stated default ("returning the op to
  // IN_PROGRESS with the rejection retained").
  reject: { from: ["SUBMITTED"], to: "IN_PROGRESS" },
};

export function assertComponentOpTransition(
  action: ComponentOperationAction,
  from: OperationStatus,
): OperationStatus {
  return assertStateTransition(COMPONENT_OP_TRANSITIONS, action, from, "ComponentOperation");
}

/**
 * Finds "the immediately preceding step for this component" using the same
 * notion of order `bom-route.ts`'s `projectComponentRoute` already uses for
 * display: canonical route position (`RouteStep.seq` within the component's
 * `routeVersion`), matched to actual rows by `operationId` — NOT the raw
 * `ComponentOperation.seq` column, whose assignment order depends on seed
 * mechanics (CSV-column order for live jobs) and isn't guaranteed to match
 * the canonical route order. Falls back to `ComponentOperation.seq - 1` only
 * when the component has no `routeVersionId` (no canonical order exists) or
 * this op's operationId isn't part of the canonical route (an "extra" op,
 * per `projectComponentRoute`'s own comment on synthesized entries) — same
 * best-effort ordering the read path falls back to in those cases.
 */
async function findPreviousComponentOperation(
  tx: Tx,
  op: ComponentOperation & { operation: { id: number } },
  routeVersionId: number | null,
): Promise<{ seq: number; status: OperationStatus } | null> {
  if (routeVersionId != null) {
    const steps = await tx.routeStep.findMany({
      where: { routeVersionId },
      orderBy: { seq: "asc" },
      select: { operationId: true },
    });
    const idx = steps.findIndex((s) => s.operationId === op.operation.id);
    if (idx > 0) {
      const prevStepOperationId = steps[idx - 1].operationId;
      return tx.componentOperation.findFirst({
        where: { componentId: op.componentId, operationId: prevStepOperationId },
        select: { seq: true, status: true },
      });
    }
    if (idx === 0) return null;
    // idx === -1: op's operation isn't in the canonical route — fall through.
  }

  return op.seq > 1
    ? tx.componentOperation.findFirst({
        where: { componentId: op.componentId, seq: op.seq - 1 },
        select: { seq: true, status: true },
      })
    : null;
}

/**
 * Locks the row FOR UPDATE (same pattern as _shared.ts's
 * lockProcessPlanForUpdate) and re-reads tenant-scoped, so nothing here ever
 * trusts a client-asserted status. Also returns the operation's
 * defaultDepartmentId (via OperationRef) for the department-scope check, and
 * the canonical-order predecessor (if any) for the sequential-route gate.
 */
async function lockComponentOperationForUpdate(
  tx: Tx,
  componentOperationId: number,
  tenantId: number,
): Promise<{
  op: ComponentOperation;
  departmentId: number | null;
  /** OperationRef.code (e.g. "CUTTING") — B9's drawing gate is CUTTING-specific, identified by code, never a hardcoded id. */
  operationCode: string;
  previousOp: { seq: number; status: OperationStatus } | null;
}> {
  await tx.$queryRaw`SELECT id FROM component_operations WHERE id = ${componentOperationId} FOR UPDATE`;

  const op = await tx.componentOperation.findFirst({
    where: { id: componentOperationId, component: { equipment: { job: { tenantId } } } },
    include: { operation: true, component: { select: { routeVersionId: true } } },
  });
  if (!op) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ComponentOperation", componentOperationId });
  }

  const previousOp = await findPreviousComponentOperation(tx, op, op.component.routeVersionId);

  return { op, departmentId: op.operation.defaultDepartmentId, operationCode: op.operation.code, previousOp };
}

function requireOperationDepartment(actor: Actor, departmentId: number | null): void {
  if (departmentId === null) {
    // Every routed operation in seed/component-routes.json's canonicalOperations
    // carries a dept — this should not happen for a properly-seeded route. Fail
    // loud rather than silently skip the scope check (CLAUDE.md #8/#12).
    throw new AppError(ERROR_CODES.GATING_BLOCKED, {
      reason: "operation has no defaultDepartmentId configured",
    });
  }
  requireDepartmentScope(actor, departmentId);
}

/**
 * NOT_STARTED -> IN_PROGRESS. Department-scoped (via the operation's
 * OperationRef.defaultDepartmentId). Gate: the previous seq on this same
 * component must be COMPLETE, or this is seq 1 — a component's route is a
 * flat sequence, so "hard sequential gating" (#2) here just means "one step
 * at a time, in order," no DAG needed. Sets startedAt from the server clock
 * (#1) — never trust a client-supplied timestamp.
 */
export async function startComponentOperation(
  actor: Actor,
  input: StartComponentOperationInput,
): Promise<ComponentOperation> {
  const { componentOperationId } = startComponentOperationSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { op, departmentId, operationCode, previousOp } = await lockComponentOperationForUpdate(
      tx,
      componentOperationId,
      actor.tenantId,
    );
    requireOperationDepartment(actor, departmentId);
    const to = assertComponentOpTransition("start", op.status);

    if (previousOp && previousOp.status !== "COMPLETE") {
      throw new AppError(ERROR_CODES.GATING_BLOCKED, {
        reason: "previous operation in this component's route is not complete",
        blockedBySeq: previousOp.seq,
        blockedByStatus: previousOp.status,
      });
    }

    // B7, Phase 4 (CLAUDE.md #2's fourth gate): the component's linked
    // BomItem must not be recorded short. SEAM no-op for untracked/never-
    // stocked parts — see _shared.ts's assertKitReady.
    await assertKitReady(tx, op.componentId, actor.tenantId);

    // B9, Phase 4: CUTTING is the one operation gated on the component's
    // governing drawing being RELEASED — identified by OperationRef.code,
    // never a hardcoded id, and never applied to any other operation (scope
    // boundary per the plan). SEAM no-op (returns null) when the component
    // has no governingDrawingId; non-null return is the current revision's
    // id, stamped onto Component.builtToRevisionId below.
    const builtToRevisionId =
      operationCode === "CUTTING" ? await assertDrawingReleased(tx, op.componentId, actor.tenantId) : null;

    // N3 (Phase 5): a reworked operation that legitimately returns to
    // NOT_STARTED (rather than staying IN_PROGRESS the way a plain F5 reject
    // leaves it — e.g. an admin correction) stamps its open Ncr's
    // reworkStartedAt here, guarded on it not already being set so this
    // never clobbers the timestamp dispositionNcr already stamped.
    const openReworkNcr = await tx.ncr.findFirst({
      where: {
        status: "REWORK_IN_PROGRESS",
        reworkStartedAt: null,
        componentOperationRejection: { componentOperationId: op.id },
      },
    });

    return audited(tx, actor, async () => {
      const updated = await tx.componentOperation.update({
        where: { id: op.id },
        data: { status: to, startedAt: new Date() },
      });
      // Server-derived stamp (invariant #1), same transaction the gate
      // check ran in — never a client-supplied revision id.
      if (builtToRevisionId != null) {
        await tx.component.update({ where: { id: op.componentId }, data: { builtToRevisionId } });
      }
      if (openReworkNcr) {
        await tx.ncr.update({ where: { id: openReworkNcr.id }, data: { reworkStartedAt: new Date() } });
      }
      return {
        result: updated,
        audit: {
          action: "componentOperation.start",
          entityType: "ComponentOperation",
          entityId: op.id,
          before: { status: op.status },
          after: {
            status: updated.status,
            startedAt: updated.startedAt,
            ...(builtToRevisionId != null ? { builtToRevisionId } : {}),
          },
          eventType: "ComponentOperationStarted",
          eventPayload: { componentOperationId: op.id, componentId: op.componentId },
        },
      };
    });
  });
}

/**
 * IN_PROGRESS -> SUBMITTED (maker step). Records submittedBy for the
 * maker-checker rule enforced at verify (#3).
 */
// TODO (plan doc §4): notify QC on submit, same pattern as submitProcess's
// notify(...) call in process.service.ts — needs a "which QC" resolution
// rule for component ops (today's notify helper resolves recipients off the
// ProcessPlan's department; a ComponentOperation would resolve off
// OperationRef.defaultDepartmentId instead). Left out of this draft.
export async function submitComponentOperation(
  actor: Actor,
  input: SubmitComponentOperationInput,
): Promise<ComponentOperation> {
  const { componentOperationId, performedByWelderId, performedByUserId, remarks, qtyPlanned, qtyGood, qtyRejected } =
    submitComponentOperationSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { op, departmentId } = await lockComponentOperationForUpdate(tx, componentOperationId, actor.tenantId);
    requireOperationDepartment(actor, departmentId);
    const to = assertComponentOpTransition("submit", op.status);
    await assertPerformedByValid(tx, actor, performedByWelderId, performedByUserId);

    // F3/F4 fields are all optional (schema) — `undefined` here (rather than
    // `null`) leaves an already-recorded value untouched instead of wiping it
    // on a resubmit that doesn't repeat it.
    return audited(tx, actor, async () => {
      const updated = await tx.componentOperation.update({
        where: { id: op.id },
        data: {
          status: to,
          submittedBy: actor.userId,
          performedByWelderId: performedByWelderId ?? undefined,
          performedByUserId: performedByUserId ?? undefined,
          remarks: remarks ?? undefined,
          qtyPlanned: qtyPlanned ?? undefined,
          qtyGood: qtyGood ?? undefined,
          qtyRejected: qtyRejected ?? undefined,
        },
      });
      return {
        result: updated,
        audit: {
          action: "componentOperation.submit",
          entityType: "ComponentOperation",
          entityId: op.id,
          before: { status: op.status, submittedBy: op.submittedBy },
          after: {
            status: updated.status,
            submittedBy: updated.submittedBy,
            performedByWelderId: updated.performedByWelderId,
            performedByUserId: updated.performedByUserId,
            remarks: updated.remarks,
            qtyPlanned: updated.qtyPlanned,
            qtyGood: updated.qtyGood,
            qtyRejected: updated.qtyRejected,
          },
          eventType: "ComponentOperationSubmitted",
          eventPayload: { componentOperationId: op.id, submittedBy: actor.userId },
        },
      };
    });
  });
}

/**
 * SUBMITTED -> COMPLETE (checker step). Maker-checker (#3): QC role AND
 * actor != submittedBy, no admin exception. Sets finishedAt + verifiedBy
 * server-side (#1).
 */
export async function verifyComponentOperation(
  actor: Actor,
  input: VerifyComponentOperationInput,
): Promise<ComponentOperation> {
  const { componentOperationId } = verifyComponentOperationSchema.parse(input);
  // Review fix: process.service.ts's verifyProcess calls this too, even
  // though assertMakerChecker already requires the QC role — nothing stops a
  // client-scoped user from also holding QC (see qcp.service.test.ts's
  // "client user is rejected" case), and #1's read-only rule has no
  // exceptions. The draft omitted this call; restored for parity.
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { op, operationCode } = await lockComponentOperationForUpdate(tx, componentOperationId, actor.tenantId);
    assertMakerChecker(actor, op.submittedBy);
    const to = assertComponentOpTransition("verify", op.status);

    // P1 (Phase 5): a PAINTING op cannot verify without a recorded coating
    // system and enough accepted DFT readings — identified by
    // OperationRef.code, same discipline as B9's CUTTING-only drawing gate
    // above. "Accepted" is self-attested by whoever recorded the reading;
    // there is no spec'd min/max micron range to check against (open
    // question noted in the schema comment and the task report — not
    // silently resolved here).
    if (operationCode === "PAINTING") {
      const paintRecord = await tx.paintRecord.findUnique({ where: { componentOperationId: op.id } });
      // Coverage is per DISTINCT coat, not a raw accepted-row count — three
      // accepted readings all against the same coatNumber (or all with it
      // omitted) must not satisfy coatsPlanned: 3 (task review Important #1).
      // groupBy folds duplicate coatNumbers together, including a null
      // coatNumber as its own single group (the "untagged" case the
      // coatsPlanned-unset/DEFAULT_COATS_REQUIRED=1 path relies on).
      const acceptedCoatGroups = await tx.dftReading.groupBy({
        by: ["coatNumber"],
        where: { componentOperationId: op.id, accepted: true },
      });
      const distinctAcceptedCoats = acceptedCoatGroups.length;
      const requiredCoats = paintRecord?.coatsPlanned ?? DEFAULT_COATS_REQUIRED;
      if (!paintRecord || distinctAcceptedCoats < requiredCoats) {
        throw new AppError(ERROR_CODES.DFT_NOT_ACCEPTED, {
          componentOperationId: op.id,
          hasPaintRecord: !!paintRecord,
          acceptedCoats: distinctAcceptedCoats,
          requiredCoats,
        });
      }
    }

    // N1 (Phase 5): re-verifying a reworked operation closes its open Ncr(s)
    // and records the elapsed rework time (closeNcr stamps reworkFinishedAt).
    // findMany, not findFirst: repeated reject→resubmit→reject cycles without
    // an intervening dispositionNcr each open a NEW Ncr (one per rejection,
    // by design), so more than one can be open at once — closing only one
    // would strand the rest permanently non-CLOSED (task review Critical #1).
    const openNcrs = await tx.ncr.findMany({
      where: { status: { not: "CLOSED" }, componentOperationRejection: { componentOperationId: op.id } },
    });

    return audited(tx, actor, async () => {
      const updated = await tx.componentOperation.update({
        where: { id: op.id },
        data: { status: to, finishedAt: new Date(), verifiedBy: actor.userId },
      });
      for (const ncr of openNcrs) {
        await closeNcr(tx, actor, { ncrId: ncr.id });
      }
      return {
        result: updated,
        audit: {
          action: "componentOperation.verify",
          entityType: "ComponentOperation",
          entityId: op.id,
          before: { status: op.status, verifiedBy: op.verifiedBy },
          after: { status: updated.status, verifiedBy: updated.verifiedBy, finishedAt: updated.finishedAt },
          eventType: "ComponentOperationVerified",
          eventPayload: { componentOperationId: op.id, submittedBy: op.submittedBy, verifiedBy: actor.userId },
        },
      };
    });
  });
}

/**
 * F5 — SUBMITTED -> IN_PROGRESS (checker rejects the maker's submission).
 * Same maker-checker gate as verify (#3): QC role AND actor != submittedBy —
 * the submitter cannot reject their own work. A category is mandatory
 * (schema); the rejection is recorded in `ComponentOperationRejection`
 * (durable, unlike the earlier draft's "nowhere to live yet") and
 * `submittedBy` is cleared so the maker must re-submit after rework.
 */
export async function rejectComponentOperation(
  actor: Actor,
  input: RejectComponentOperationInput,
): Promise<ComponentOperation> {
  const { componentOperationId, categoryId, detail } = rejectComponentOperationSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { op } = await lockComponentOperationForUpdate(tx, componentOperationId, actor.tenantId);
    assertMakerChecker(actor, op.submittedBy);
    const to = assertComponentOpTransition("reject", op.status);

    return audited(tx, actor, async () => {
      const updated = await tx.componentOperation.update({
        where: { id: op.id },
        data: { status: to, submittedBy: null },
      });
      const rejection = await tx.componentOperationRejection.create({
        data: { componentOperationId: op.id, categoryId, detail: detail ?? null, rejectedBy: actor.userId },
      });
      // N1 (Phase 5): every rejection opens exactly one Ncr for QC to
      // disposition — the rework/QA workflow layered on top of the
      // immutable rejection record.
      await tx.ncr.create({ data: { componentOperationRejectionId: rejection.id } });

      // S14 — was silent. QC is who dispositions an Ncr (S11's disposition
      // UI), so QC is who needs to know one opened, same transaction as the
      // ncr.create above (a failed notify rolls back the whole reject).
      const qcIds = await userIdsWithRole(tx, actor.tenantId, ROLES.QC);
      if (qcIds.length > 0) {
        const ctx = await tx.componentOperation.findUniqueOrThrow({
          where: { id: op.id },
          select: {
            operation: { select: { name: true } },
            component: {
              select: {
                tag: true,
                unitId: true,
                unit: { select: { serialNo: true } },
                equipment: { select: { jobId: true, job: { select: { jobNumber: true } } } },
              },
            },
          },
        });
        await notify(
          tx,
          actor.tenantId,
          qcIds.map((recipientId) => ({
            recipientId,
            type: "NCR_OPENED",
            entityType: "ComponentOperation",
            entityId: op.id,
            title: `NCR opened: ${ctx.component.tag} · ${ctx.operation.name}`,
            body: `${ctx.component.equipment.job.jobNumber}${ctx.component.unit ? ` · Unit ${ctx.component.unit.serialNo}` : ""}`,
            payload: { jobId: ctx.component.equipment.jobId, unitId: ctx.component.unitId },
          })),
        );
      }

      return {
        result: updated,
        audit: {
          action: "componentOperation.reject",
          entityType: "ComponentOperation",
          entityId: op.id,
          before: { status: op.status, submittedBy: op.submittedBy },
          after: { status: updated.status, submittedBy: updated.submittedBy, categoryId, detail },
          eventType: "ComponentOperationRejected",
          eventPayload: {
            componentOperationId: op.id,
            submittedBy: op.submittedBy,
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
 * Records/updates the coating system for a PAINTING op (P1, Phase 5).
 * PaintRecord is 1:1 with ComponentOperation — upsert so re-recording (e.g.
 * a corrected coats-planned figure before verify) doesn't need a separate
 * update action. Not restricted to the PAINTING op code: a component's route
 * decides which ops exist, and there is no product reason to refuse
 * recording a coating system against a non-PAINTING op id someone points it
 * at — the verify-time gate only ever fires for the code that matters.
 */
export async function recordPaintRecord(actor: Actor, input: RecordPaintRecordInput): Promise<PaintRecord> {
  const { componentOperationId, coatingSystem, coatsPlanned } = recordPaintRecordSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { op, departmentId } = await lockComponentOperationForUpdate(tx, componentOperationId, actor.tenantId);
    requireOperationDepartment(actor, departmentId);

    return audited(tx, actor, async () => {
      const record = await tx.paintRecord.upsert({
        where: { componentOperationId: op.id },
        create: { componentOperationId: op.id, coatingSystem, coatsPlanned: coatsPlanned ?? null },
        update: { coatingSystem, coatsPlanned: coatsPlanned ?? null },
      });
      return {
        result: record,
        audit: {
          action: "paintRecord.record",
          entityType: "PaintRecord",
          entityId: record.id,
          after: { coatingSystem: record.coatingSystem, coatsPlanned: record.coatsPlanned },
          eventType: "PaintRecordRecorded",
          eventPayload: { componentOperationId: op.id, coatingSystem, coatsPlanned: coatsPlanned ?? null },
        },
      };
    });
  });
}

/**
 * Records a single DFT reading against a ComponentOperation (P1, Phase 5).
 * `accepted` is self-attested by whoever records it — see the schema
 * comment; there is no spec'd min/max micron range to validate against.
 */
export async function recordDftReading(actor: Actor, input: RecordDftReadingInput): Promise<DftReading> {
  const { componentOperationId, coatNumber, location, readingMicrons, accepted } =
    recordDftReadingSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { op, departmentId } = await lockComponentOperationForUpdate(tx, componentOperationId, actor.tenantId);
    requireOperationDepartment(actor, departmentId);

    return audited(tx, actor, async () => {
      const reading = await tx.dftReading.create({
        data: {
          componentOperationId: op.id,
          coatNumber: coatNumber ?? null,
          location: location ?? null,
          readingMicrons,
          accepted,
          recordedBy: actor.userId,
        },
      });
      return {
        result: reading,
        audit: {
          action: "dftReading.record",
          entityType: "DftReading",
          entityId: reading.id,
          after: { readingMicrons: reading.readingMicrons, accepted: reading.accepted, coatNumber: reading.coatNumber },
          eventType: "DftReadingRecorded",
          eventPayload: { componentOperationId: op.id, readingMicrons, accepted },
        },
      };
    });
  });
}
