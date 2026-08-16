import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import {
  assertNotClientUser,
  requireDepartmentScope,
  type Actor,
} from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { fileDelayReasonSchema, type FileDelayReasonInput } from "@/lib/shared/schemas";
import type { DelayReason } from "@/generated/prisma/client";
import { lockProcessPlanForUpdate } from "./_shared";

/**
 * Delay reasons (CLAUDE.md invariant #7).
 *
 * Filing a categorised reason is the ONLY thing that clears the block
 * assertNoUnfiledDelayBlock enforces: once a department's overdue ProcessPlan
 * has a DelayReason row, that department's progress writes on the unit flow
 * again. So this service is the unblock half of the mandatory-delay-reason
 * invariant — the block half lives in _shared + the other progress services.
 */

/**
 * File the delay reason invariant #7 requires. Locks the plan row first
 * (concurrency contract: serialise with any transition on the same plan),
 * scopes the actor to the plan's owning department, checks the category is
 * real, then writes the reason + its audit row in one transaction. filedAt is
 * the DB default now() — never a client value (invariant #1); the request
 * schema is .strict() so it structurally cannot carry a timestamp.
 */
export async function fileDelayReason(
  actor: Actor,
  input: FileDelayReasonInput,
): Promise<DelayReason> {
  const { processPlanId, categoryId, detail } = fileDelayReasonSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const plan = await lockProcessPlanForUpdate(tx, processPlanId, actor.tenantId); // throws NOT_FOUND
    requireDepartmentScope(actor, plan.ownerDepartmentId);

    const category = await tx.delayCategoryRef.findUnique({ where: { id: categoryId } });
    if (!category) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "DelayCategoryRef", categoryId });
    }

    return audited(tx, actor, async () => {
      const reason = await tx.delayReason.create({
        data: {
          processPlanId,
          categoryId,
          detail: detail ?? null,
          filedBy: actor.userId,
          // filedAt: DB default now(); reviewStatus: DB default PENDING.
        },
      });
      return {
        result: reason,
        audit: {
          action: "delay.file",
          entityType: "DelayReason",
          entityId: reason.id,
          after: { processPlanId, categoryId, ownerDepartmentId: plan.ownerDepartmentId },
          eventType: "DelayReasonFiled",
          eventPayload: { processPlanId, categoryId, ownerDepartmentId: plan.ownerDepartmentId },
        },
      };
    });
  });
}

// ponytail: reviewDelayReason (PRODUCTION_HEAD ACKNOWLEDGE/DISPUTE, setting
// reviewStatus + reviewedBy) is deferred — it needs its own .strict() schema
// in lib/shared/schemas and an error/enum contract that isn't defined yet, and
// nothing in Phase 1 reads reviewStatus. Add it here when the review UI lands:
// requireRole(actor, PRODUCTION_HEAD) → lock nothing (no plan transition) →
// update the DelayReason row + audit, same audited() shape as above.
