import { withTenant, type Tx } from "@/lib/db";
import { type Actor, assertMakerChecker, assertNotClientUser, requireDepartmentScope } from "@/lib/authz";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  startComponentOperationSchema,
  submitComponentOperationSchema,
  verifyComponentOperationSchema,
  type StartComponentOperationInput,
  type SubmitComponentOperationInput,
  type VerifyComponentOperationInput,
} from "@/lib/shared/schemas";
import type { ComponentOperation, OperationStatus } from "@/generated/prisma/client";

/**
 * DRAFT — first cut, not yet wired into a Server Action or the BomPanel UI,
 * not run against a live DB. Mirrors src/lib/services/process.service.ts's
 * state machine and invariant gates as closely as the two entities' shapes
 * allow (CLAUDE.md #1/#2/#3/#5/#8/#12) — same review pass this project runs
 * on every other service file before it ships is still owed to this one.
 *
 * Grain: ComponentOperation is the per-part fabrication step (Shell rolling,
 * forming, cutting, welding, NDT, inspection, ...) — this is the
 * "sub-assembly" tracker. It's deliberately simpler than ProcessPlan's state
 * machine: no HOLD/resume, and no cross-component DAG — a component's own
 * route is a flat ordered sequence (RouteStep.seq), so the only ordering
 * gate is "the previous seq on THIS component must be COMPLETE", not a full
 * predecessor graph. reject() is left out of this draft on purpose: a
 * rejection reason has nowhere durable to live yet (DelayReason is keyed to
 * processPlanId only) — see the plan doc for the two ways to close that gap.
 */

export type ComponentOperationAction = "start" | "submit" | "verify";

export const COMPONENT_OP_TRANSITIONS: Record<
  ComponentOperationAction,
  { from: OperationStatus[]; to: OperationStatus }
> = {
  start: { from: ["NOT_STARTED"], to: "IN_PROGRESS" },
  submit: { from: ["IN_PROGRESS"], to: "SUBMITTED" },
  verify: { from: ["SUBMITTED"], to: "COMPLETE" },
};

export function assertComponentOpTransition(
  action: ComponentOperationAction,
  from: OperationStatus,
): OperationStatus {
  const t = COMPONENT_OP_TRANSITIONS[action];
  if (!t.from.includes(from)) {
    throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, {
      entity: "ComponentOperation",
      action,
      from,
      allowedFrom: t.from,
      to: t.to,
    });
  }
  return t.to;
}

/**
 * Locks the row FOR UPDATE (same pattern as _shared.ts's
 * lockProcessPlanForUpdate) and re-reads tenant-scoped, so nothing here ever
 * trusts a client-asserted status. Also returns the operation's
 * defaultDepartmentId (via OperationRef) for the department-scope check, and
 * the previous-seq sibling (if any) for the sequential-route gate.
 */
async function lockComponentOperationForUpdate(
  tx: Tx,
  componentOperationId: number,
  tenantId: number,
): Promise<{
  op: ComponentOperation;
  departmentId: number | null;
  previousOp: { seq: number; status: OperationStatus } | null;
}> {
  await tx.$queryRaw`SELECT id FROM component_operations WHERE id = ${componentOperationId} FOR UPDATE`;

  const op = await tx.componentOperation.findFirst({
    where: { id: componentOperationId, component: { equipment: { job: { tenantId } } } },
    include: { operation: true },
  });
  if (!op) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ComponentOperation", componentOperationId });
  }

  const previousOp =
    op.seq > 1
      ? await tx.componentOperation.findFirst({
          where: { componentId: op.componentId, seq: op.seq - 1 },
          select: { seq: true, status: true },
        })
      : null;

  return { op, departmentId: op.operation.defaultDepartmentId, previousOp };
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
    const { op, departmentId, previousOp } = await lockComponentOperationForUpdate(
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

    return audited(tx, actor, async () => {
      const updated = await tx.componentOperation.update({
        where: { id: op.id },
        data: { status: to, startedAt: new Date() },
      });
      return {
        result: updated,
        audit: {
          action: "componentOperation.start",
          entityType: "ComponentOperation",
          entityId: op.id,
          before: { status: op.status },
          after: { status: updated.status, startedAt: updated.startedAt },
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
  const { componentOperationId } = submitComponentOperationSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const { op, departmentId } = await lockComponentOperationForUpdate(tx, componentOperationId, actor.tenantId);
    requireOperationDepartment(actor, departmentId);
    const to = assertComponentOpTransition("submit", op.status);

    return audited(tx, actor, async () => {
      const updated = await tx.componentOperation.update({
        where: { id: op.id },
        data: { status: to, submittedBy: actor.userId },
      });
      return {
        result: updated,
        audit: {
          action: "componentOperation.submit",
          entityType: "ComponentOperation",
          entityId: op.id,
          before: { status: op.status, submittedBy: op.submittedBy },
          after: { status: updated.status, submittedBy: updated.submittedBy },
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
    const { op } = await lockComponentOperationForUpdate(tx, componentOperationId, actor.tenantId);
    assertMakerChecker(actor, op.submittedBy);
    const to = assertComponentOpTransition("verify", op.status);

    return audited(tx, actor, async () => {
      const updated = await tx.componentOperation.update({
        where: { id: op.id },
        data: { status: to, finishedAt: new Date(), verifiedBy: actor.userId },
      });
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
