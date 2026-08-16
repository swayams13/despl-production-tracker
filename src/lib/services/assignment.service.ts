import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import {
  assertNotClientUser,
  hasRole,
  requireDepartmentScope,
  requireRole,
  ROLES,
  type Actor,
} from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  claimPlanSchema,
  assignPlanSchema,
  releasePlanSchema,
  type ClaimPlanInput,
  type AssignPlanInput,
  type ReleasePlanInput,
} from "@/lib/shared/schemas";
import type { ProcessPlan } from "@/generated/prisma/client";
import { lockProcessPlanForUpdate, loadPlanNotifyContext } from "./_shared";
import { notify } from "./notifications.service";

/**
 * Who a plan appears on whose list for (personal dashboards v1, SPEC §5.1).
 *
 * D16 (non-negotiable): assignment never influences gating. This file never
 * imports process.service.ts or touches a gate check — it only ever reads
 * and writes ProcessPlan.assigneeUserId. Whether a plan may start/complete is
 * entirely process.service.ts's concern, unaffected by who (if anyone) it is
 * assigned to.
 */

/**
 * Claim an unassigned plan into the caller's own name. Anyone in the plan's
 * owning department may do this — not an admin/PH bypass (unlike
 * requireDepartmentScope's usual semantics), so this is an inline department
 * check with the spec's own NOT_IN_DEPARTMENT code, not requireDepartmentScope
 * (which always throws the generic FORBIDDEN and lets ADMIN/PH bypass — an
 * ADMIN with no department membership must NOT be able to claim into a pool
 * they don't belong to).
 */
export async function claimPlan(actor: Actor, input: ClaimPlanInput): Promise<ProcessPlan> {
  const { processPlanId } = claimPlanSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId); // throws NOT_FOUND

    if (!actor.departmentIds.includes(plan.ownerDepartmentId)) {
      throw new AppError(ERROR_CODES.NOT_IN_DEPARTMENT, {
        ownerDepartmentId: plan.ownerDepartmentId,
        scopedTo: actor.departmentIds,
      });
    }
    if (plan.status === "COMPLETE") {
      throw new AppError(ERROR_CODES.PLAN_COMPLETE, { processPlanId });
    }
    if (plan.assigneeUserId != null) {
      throw new AppError(ERROR_CODES.ALREADY_ASSIGNED, {
        processPlanId,
        assigneeUserId: plan.assigneeUserId,
      });
    }

    // ponytail: no "you were assigned" notification here — the affected user
    // IS the actor (they just clicked "claim"), so notifying yourself about
    // your own action is noise, not signal. assignPlan below (a *different*
    // user assigning someone else) is the case SPEC §8 actually needs.
    return audited(tx, actor, async () => {
      const updated = await tx.processPlan.update({
        where: { id: processPlanId },
        data: { assigneeUserId: actor.userId },
      });
      return {
        result: updated,
        audit: {
          action: "assignment.claim",
          entityType: "ProcessPlan",
          entityId: updated.id,
          before: { assigneeUserId: null },
          after: { assigneeUserId: actor.userId },
          eventType: "PlanClaimed",
          eventPayload: { processPlanId, assigneeUserId: actor.userId },
        },
      };
    });
  });
}

/**
 * Assign a plan to a specific user. Allowed for the owning department's
 * SUPERVISOR, or PRODUCTION_HEAD/ADMIN unconditionally — exactly
 * requireDepartmentScope's existing role/bypass semantics, so it's reused
 * as-is (unlike claimPlan, which needs its own inline check). A supervisor of
 * a different department is refused FORBIDDEN by that helper. Overwrites any
 * existing assignee (reassignment); the audit row records before → after.
 */
export async function assignPlan(actor: Actor, input: AssignPlanInput): Promise<ProcessPlan> {
  const { processPlanId, userId } = assignPlanSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId); // throws NOT_FOUND
    requireDepartmentScope(actor, plan.ownerDepartmentId);

    const target = await tx.user.findFirst({
      where: { id: userId },
      include: { departments: true },
    });
    // A cross-tenant/nonexistent userId is already invisible under RLS
    // (findFirst → null); treated the same as "doesn't hold the department".
    if (!target || !target.departments.some((d) => d.departmentId === plan.ownerDepartmentId)) {
      throw new AppError(ERROR_CODES.ASSIGNEE_NOT_IN_DEPARTMENT, {
        userId,
        ownerDepartmentId: plan.ownerDepartmentId,
      });
    }
    if (!target.active) {
      throw new AppError(ERROR_CODES.ASSIGNEE_INACTIVE, { userId });
    }

    const before = plan.assigneeUserId;
    const updated = await audited(tx, actor, async () => {
      const updated = await tx.processPlan.update({
        where: { id: processPlanId },
        data: { assigneeUserId: userId },
      });
      return {
        result: updated,
        audit: {
          action: "assignment.assign",
          entityType: "ProcessPlan",
          entityId: updated.id,
          before: { assigneeUserId: before },
          after: { assigneeUserId: userId },
          eventType: "PlanAssigned",
          eventPayload: { processPlanId, assigneeUserId: userId },
        },
      };
    });

    // SPEC §8: "you were assigned…" — same transaction as the state change.
    const ctx = await loadPlanNotifyContext(tx, updated);
    await notify(tx, actor.tenantId, [
      {
        recipientId: userId,
        type: "PLAN_ASSIGNED",
        entityType: "ProcessPlan",
        entityId: updated.id,
        title: `You were assigned ${ctx.processName}${ctx.serialNo ? ` — Unit ${ctx.serialNo}` : ""}`,
        body: `By ${actor.name} · ${ctx.jobNumber}`,
        payload: { jobId: ctx.jobId, unitId: ctx.unitId, stageNo: ctx.stageNo },
      },
    ]);

    return updated;
  });
}

/**
 * Return a plan to the department pool (assigneeUserId → null). Four
 * distinct allow-paths: the assignee themselves, the owning department's
 * SUPERVISOR, PRODUCTION_HEAD, or ADMIN. Anything else is FORBIDDEN.
 */
export async function releasePlan(actor: Actor, input: ReleasePlanInput): Promise<ProcessPlan> {
  const { processPlanId } = releasePlanSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId); // throws NOT_FOUND

    const isAssignee = actor.userId === plan.assigneeUserId;
    const isDeptSupervisor =
      hasRole(actor, ROLES.SUPERVISOR) && actor.departmentIds.includes(plan.ownerDepartmentId);
    const isPhOrAdmin = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
    if (!isAssignee && !isDeptSupervisor && !isPhOrAdmin) {
      throw new AppError(ERROR_CODES.FORBIDDEN, {
        reason: "not the assignee, and not the owning department's supervisor/PH/admin",
        processPlanId,
      });
    }

    // Already in the pool: nothing changed, so nothing to record. The audit
    // log is append-only — a before === after === null row is permanent
    // noise. Checked AFTER the permission gate above, so a no-op release is
    // refused for exactly the same callers a real one would be.
    if (plan.assigneeUserId == null) return plan;

    const before = plan.assigneeUserId;
    return audited(tx, actor, async () => {
      const updated = await tx.processPlan.update({
        where: { id: processPlanId },
        data: { assigneeUserId: null },
      });
      return {
        result: updated,
        audit: {
          action: "assignment.release",
          entityType: "ProcessPlan",
          entityId: updated.id,
          before: { assigneeUserId: before },
          after: { assigneeUserId: null },
          eventType: "PlanReleased",
          eventPayload: { processPlanId },
        },
      };
    });
  });
}
