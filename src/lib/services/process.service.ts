import { withTenant, type Tx } from "@/lib/db";
import {
  type Actor,
  assertMakerChecker,
  assertNotClientUser,
  requireDepartmentScope,
} from "@/lib/authz";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { assertStateTransition } from "./state-machine";
import {
  assertCanComplete,
  assertCanStart,
  type PredecessorState,
  type ScheduleEdge,
} from "@/lib/schedule";
import {
  holdProcessSchema,
  rejectProcessSchema,
  startProcessSchema,
  submitProcessSchema,
  verifyProcessSchema,
  type HoldProcessInput,
  type RejectProcessInput,
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
  loadPlanNotifyContext,
} from "./_shared";
import { notify, userIdsWithRole } from "./notifications.service";
import type { ProcessPlan, ProcessPlanStatus } from "@/generated/prisma/client";

/**
 * The process-update state machine (CLAUDE.md invariants #2/#3/#4/#5/#7/#11).
 * Each transition is one transaction: lock the plan row FOR UPDATE, re-read the
 * source state from the DB (never trust a client-asserted status), run the
 * invariant gates, then write the new status + a server-clock actual_* and its
 * audit row atomically. If any gate throws — always an AppError with a stable
 * code (#12) — nothing is written.
 *
 * Grain is PER-UNIT: ProcessPlan.unitId is the serial (per-serial expansion
 * has landed — loadGate threads plan.unitId through). Job/equipment grain
 * with unitId null remains a supported fallback for unit-less jobs.
 * assertNoOpenHoldPoint actively enforces per unit — see _shared.ts.
 */

// ── Pure state machine (exported so the transition matrix is unit-testable) ──

export type ProcessAction = "start" | "submit" | "verify" | "reject" | "hold" | "resume";

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
  reject: { from: ["SUBMITTED"], to: "IN_PROGRESS" },
  hold: { from: ["IN_PROGRESS", "SUBMITTED"], to: "ON_HOLD" },
  resume: { from: ["ON_HOLD"], to: "IN_PROGRESS" },
};

/** Reject an illegal source state (invariant: the state machine, not the UI). */
export function assertTransition(action: ProcessAction, from: ProcessPlanStatus): ProcessPlanStatus {
  return assertStateTransition(TRANSITIONS, action, from, "ProcessPlan");
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
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId);
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
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId);
    requireDepartmentScope(actor, plan.ownerDepartmentId);
    const to = assertTransition("submit", plan.status);

    await assertNoUnfiledDelayBlock(tx, {
      ownerDepartmentId: plan.ownerDepartmentId,
      scheduleRunId: plan.scheduleRunId,
      unitId: plan.unitId,
    });

    const updated = await audited(tx, actor, async () => {
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

    // §6: "item submitted → QC" — same transaction, so a failed notify rolls
    // back the whole submit rather than leaving a silent gap.
    const qcIds = await userIdsWithRole(tx, actor.tenantId, "QC");
    const ctx = await loadPlanNotifyContext(tx, updated);
    await notify(
      tx,
      actor.tenantId,
      qcIds.map((recipientId) => ({
        recipientId,
        type: "ITEM_SUBMITTED",
        entityType: "ProcessPlan",
        entityId: updated.id,
        title: `${ctx.processName} awaiting your verification${ctx.serialNo ? ` — Unit ${ctx.serialNo}` : ""}`,
        body: `Submitted by ${actor.name} · ${ctx.jobNumber}`,
        payload: { jobId: ctx.jobId, unitId: ctx.unitId, stageNo: ctx.stageNo },
      })),
    );

    return updated;
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
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId);
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
 * SUBMITTED → IN_PROGRESS (checker rejects the maker's submission). Same
 * maker–checker gate as verify (#3): QC role AND actor ≠ submittedBy — the
 * person who submitted cannot reject their own work. A reason is mandatory
 * (schema) and recorded in the append-only trail; `submittedBy` is cleared so
 * the maker must re-submit after rework. No hold/predecessor gate: rejecting is
 * always allowed on a submitted item, it only sends work back.
 */
export async function rejectProcess(actor: Actor, input: RejectProcessInput): Promise<ProcessPlan> {
  const { processPlanId, reason } = rejectProcessSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId);
    assertMakerChecker(actor, plan.submittedBy);
    const to = assertTransition("reject", plan.status);

    const maker = plan.submittedBy;
    const updated = await audited(tx, actor, async () => {
      const updated = await tx.processPlan.update({
        where: { id: plan.id },
        data: { status: to, submittedBy: null },
      });
      return {
        result: updated,
        audit: {
          action: "process.reject",
          entityType: "ProcessPlan",
          entityId: plan.id,
          before: { status: plan.status, submittedBy: plan.submittedBy },
          after: { status: updated.status, submittedBy: updated.submittedBy, reason },
          eventType: "ProcessRejected",
          eventPayload: { processPlanId: plan.id, submittedBy: plan.submittedBy, rejectedBy: actor.userId, reason },
        },
      };
    });

    // §6: "reject → maker" — same transaction as the state change.
    if (maker != null) {
      const ctx = await loadPlanNotifyContext(tx, updated);
      await notify(tx, actor.tenantId, [
        {
          recipientId: maker,
          type: "ITEM_REJECTED",
          entityType: "ProcessPlan",
          entityId: updated.id,
          title: `${ctx.processName} rejected${ctx.serialNo ? ` — Unit ${ctx.serialNo}` : ""}`,
          body: `${reason} · ${actor.name}`,
          payload: { jobId: ctx.jobId, unitId: ctx.unitId, stageNo: ctx.stageNo },
        },
      ]);
    }

    return updated;
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
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId);
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
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId);
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
