import { withTenant, type Tx } from "@/lib/db";
import {
  type Actor,
  assertMakerChecker,
  assertNotClientUser,
  requireDepartmentScope,
} from "@/lib/authz";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  assertCanComplete,
  assertCanStart,
  type PredecessorState,
  type ScheduleEdge,
} from "@/lib/schedule";
import {
  holdProcessSchema,
  startProcessSchema,
  submitProcessSchema,
  verifyProcessSchema,
  type HoldProcessInput,
  type StartProcessInput,
  type SubmitProcessInput,
  type VerifyProcessInput,
} from "@/lib/shared/schemas";
import {
  assertNoOpenHoldPoint,
  assertNoUnfiledDelayBlock,
  jobEdgeToScheduleEdge,
  lockProcessPlanForUpdate,
  loadPredecessorStates,
} from "./_shared";
import type { ProcessPlan, ProcessPlanStatus } from "@/generated/prisma/client";

/**
 * The process-update state machine (CLAUDE.md invariants #2/#3/#4/#5/#7/#11).
 * Each transition is one transaction: lock the plan row FOR UPDATE, re-read the
 * source state from the DB (never trust a client-asserted status), run the
 * invariant gates, then write the new status + a server-clock actual_* and its
 * audit row atomically. If any gate throws — always an AppError with a stable
 * code (#12) — nothing is written.
 *
 * Grain is JOB/EQUIPMENT: ProcessPlan.unitId is null (per-serial expansion is a
 * documented seam, not built). assertNoOpenHoldPoint is therefore a no-op here
 * until per-unit QCP executions exist — see _shared.ts.
 */

// ── Pure state machine (exported so the transition matrix is unit-testable) ──

export type ProcessAction = "start" | "submit" | "verify" | "hold" | "resume";

/**
 * The only legal (from → to) edges. hold is reachable from either active state;
 * resume returns to IN_PROGRESS.
 *
 * // ponytail: resume goes to IN_PROGRESS, not "whatever it was before the
 * // hold" — ProcessPlan has no prior-status column, so a plan held while
 * // SUBMITTED must be re-submitted after resume (submittedBy is left as-is and
 * // overwritten on the next submit). Add a heldFromStatus column only if the
 * // floor actually needs hold to preserve a submission.
 */
export const TRANSITIONS: Record<ProcessAction, { from: ProcessPlanStatus[]; to: ProcessPlanStatus }> = {
  start: { from: ["NOT_STARTED"], to: "IN_PROGRESS" },
  submit: { from: ["IN_PROGRESS"], to: "SUBMITTED" },
  verify: { from: ["SUBMITTED"], to: "COMPLETE" },
  hold: { from: ["IN_PROGRESS", "SUBMITTED"], to: "ON_HOLD" },
  resume: { from: ["ON_HOLD"], to: "IN_PROGRESS" },
};

/** Reject an illegal source state (invariant: the state machine, not the UI). */
export function assertTransition(action: ProcessAction, from: ProcessPlanStatus): ProcessPlanStatus {
  const t = TRANSITIONS[action];
  if (!t.from.includes(from)) {
    throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, {
      action,
      from,
      allowedFrom: t.from,
      to: t.to,
    });
  }
  return t.to;
}

// ── Gating inputs ────────────────────────────────────────────────────────

/** The process's incoming edges (mapped for the engine) + its predecessor states. */
async function loadGate(
  tx: Tx,
  plan: ProcessPlan,
): Promise<{ edges: ScheduleEdge[]; states: PredecessorState[] }> {
  const rawEdges = await tx.jobProcessEdge.findMany({ where: { processId: plan.jobProcessId } });
  const states = await loadPredecessorStates(tx, plan.scheduleRunId, plan.jobProcessId, plan.unitId);
  return { edges: rawEdges.map(jobEdgeToScheduleEdge), states };
}

// ── Transitions ──────────────────────────────────────────────────────────

/**
 * NOT_STARTED → IN_PROGRESS. Department-scoped; the department may owe no
 * unfiled delay reason (#7); every predecessor must be advanced enough to start
 * per its edge type (#2/#11). Sets actualStart from the server clock (#1).
 */
export async function startProcess(actor: Actor, input: StartProcessInput): Promise<ProcessPlan> {
  const { processPlanId } = startProcessSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId);
    requireDepartmentScope(actor, plan.ownerDepartmentId);
    const to = assertTransition("start", plan.status);

    await assertNoUnfiledDelayBlock(tx, {
      ownerDepartmentId: plan.ownerDepartmentId,
      scheduleRunId: plan.scheduleRunId,
      unitId: plan.unitId,
    });

    const { edges, states } = await loadGate(tx, plan);
    assertCanStart(edges, states);

    return audited(tx, actor, async () => {
      const updated = await tx.processPlan.update({
        where: { id: plan.id },
        data: { status: to, actualStart: new Date() },
      });
      return {
        result: updated,
        audit: {
          action: "process.start",
          entityType: "ProcessPlan",
          entityId: plan.id,
          before: { status: plan.status },
          after: { status: updated.status, actualStart: updated.actualStart },
          eventType: "ProcessStarted",
          eventPayload: { processPlanId: plan.id, jobProcessId: plan.jobProcessId },
        },
      };
    });
  });
}

/**
 * IN_PROGRESS → SUBMITTED (maker step). Department-scoped; records submittedBy
 * for the maker–checker rule enforced at verify. Delay block (#7) still applies.
 */
export async function submitProcess(actor: Actor, input: SubmitProcessInput): Promise<ProcessPlan> {
  const { processPlanId } = submitProcessSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId);
    requireDepartmentScope(actor, plan.ownerDepartmentId);
    const to = assertTransition("submit", plan.status);

    await assertNoUnfiledDelayBlock(tx, {
      ownerDepartmentId: plan.ownerDepartmentId,
      scheduleRunId: plan.scheduleRunId,
      unitId: plan.unitId,
    });

    return audited(tx, actor, async () => {
      const updated = await tx.processPlan.update({
        where: { id: plan.id },
        data: { status: to, submittedBy: actor.userId },
      });
      return {
        result: updated,
        audit: {
          action: "process.submit",
          entityType: "ProcessPlan",
          entityId: plan.id,
          before: { status: plan.status, submittedBy: plan.submittedBy },
          after: { status: updated.status, submittedBy: updated.submittedBy },
          eventType: "ProcessSubmitted",
          eventPayload: { processPlanId: plan.id, submittedBy: actor.userId },
        },
      };
    });
  });
}

/**
 * SUBMITTED → COMPLETE (checker step). Maker–checker (#3): QC role AND
 * actor ≠ submittedBy, no admin exception. Every predecessor must be COMPLETE
 * (#11 — a negative lag never lets a process finish out of order), and no hold
 * point may be open (#4). Sets actualFinish + verifiedBy server-side (#1).
 */
export async function verifyProcess(actor: Actor, input: VerifyProcessInput): Promise<ProcessPlan> {
  const { processPlanId } = verifyProcessSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId);
    assertMakerChecker(actor, plan.submittedBy);
    const to = assertTransition("verify", plan.status);

    const { edges, states } = await loadGate(tx, plan);
    assertCanComplete(edges, states);
    await assertNoOpenHoldPoint(tx, { jobProcessId: plan.jobProcessId, unitId: plan.unitId });

    return audited(tx, actor, async () => {
      const updated = await tx.processPlan.update({
        where: { id: plan.id },
        data: { status: to, actualFinish: new Date(), verifiedBy: actor.userId },
      });
      return {
        result: updated,
        audit: {
          action: "process.verify",
          entityType: "ProcessPlan",
          entityId: plan.id,
          before: { status: plan.status, verifiedBy: plan.verifiedBy },
          after: { status: updated.status, verifiedBy: updated.verifiedBy, actualFinish: updated.actualFinish },
          eventType: "ProcessVerified",
          eventPayload: { processPlanId: plan.id, submittedBy: plan.submittedBy, verifiedBy: actor.userId },
        },
      };
    });
  });
}

/**
 * IN_PROGRESS | SUBMITTED → ON_HOLD, with a mandatory reason. The reason lives
 * in the append-only audit trail / domain event, not a ProcessPlan column
 * (nothing reads a live "hold reason" today).
 */
export async function holdProcess(actor: Actor, input: HoldProcessInput): Promise<ProcessPlan> {
  const { processPlanId, reason } = holdProcessSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId);
    requireDepartmentScope(actor, plan.ownerDepartmentId);
    const to = assertTransition("hold", plan.status);

    return audited(tx, actor, async () => {
      const updated = await tx.processPlan.update({
        where: { id: plan.id },
        data: { status: to },
      });
      return {
        result: updated,
        audit: {
          action: "process.hold",
          entityType: "ProcessPlan",
          entityId: plan.id,
          before: { status: plan.status },
          after: { status: updated.status, reason },
          eventType: "ProcessHeld",
          eventPayload: { processPlanId: plan.id, reason },
        },
      };
    });
  });
}

/**
 * ON_HOLD → IN_PROGRESS. Resuming already-started work; no start gating is
 * re-run because the plan already cleared it when it first started.
 *
 * // ponytail: same { processPlanId } shape as start — reuse its schema rather
 * // than add a duplicate resumeProcessSchema.
 */
export async function resumeProcess(actor: Actor, input: StartProcessInput): Promise<ProcessPlan> {
  const { processPlanId } = startProcessSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId);
    requireDepartmentScope(actor, plan.ownerDepartmentId);
    const to = assertTransition("resume", plan.status);

    return audited(tx, actor, async () => {
      const updated = await tx.processPlan.update({
        where: { id: plan.id },
        data: { status: to },
      });
      return {
        result: updated,
        audit: {
          action: "process.resume",
          entityType: "ProcessPlan",
          entityId: plan.id,
          before: { status: plan.status },
          after: { status: updated.status },
          eventType: "ProcessResumed",
          eventPayload: { processPlanId: plan.id },
        },
      };
    });
  });
}
