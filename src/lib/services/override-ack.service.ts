import { withTenant } from "@/lib/db";
import { type Actor, assertNotClientUser, hasRole, ROLES } from "@/lib/authz";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { acknowledgeOverrideSchema, type AcknowledgeOverrideInput } from "@/lib/shared/schemas";

/**
 * D2 Acknowledge: the Production Head marks an out-of-sequence (SOFT) start as
 * seen. It writes one append-only SequenceOverrideAck row and an audit row and
 * touches nothing else: the work item's state, dates and the override row are
 * unchanged, and no work is ever blocked on it. Any user in the role may
 * acknowledge, including the one whose team made the override. Admins are not
 * exempt from the role check.
 *
 * A second acknowledgement is refused (OVERRIDE_ALREADY_ACKNOWLEDGED) and writes
 * nothing, so a double tap or a replay leaves exactly one row and one audit entry.
 */
export async function acknowledgeOverride(actor: Actor, input: AcknowledgeOverrideInput): Promise<{ overrideId: number; acknowledgedAt: Date }> {
  const { overrideId } = acknowledgeOverrideSchema.parse(input);
  assertNotClientUser(actor);
  if (!hasRole(actor, ROLES.PRODUCTION_HEAD)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, { required: [ROLES.PRODUCTION_HEAD], held: actor.roles, reason: "Only the Production Head can acknowledge an early start." });
  }

  return withTenant(actor.tenantId, async (tx) => {
    // Explicit tenant filter: another tenant's id is NOT_FOUND, never "forbidden".
    const o = await tx.sequenceOverride.findFirst({
      where: { id: overrideId, tenantId: actor.tenantId },
      select: { id: true, jobId: true, targetKind: true, targetId: true, unitId: true, ack: { select: { id: true } } },
    });
    if (!o) throw new AppError(ERROR_CODES.NOT_FOUND, { overrideId });
    if (o.ack) throw new AppError(ERROR_CODES.OVERRIDE_ALREADY_ACKNOWLEDGED, { overrideId });

    return audited(tx, actor, async () => {
      let ack;
      try {
        ack = await tx.sequenceOverrideAck.create({ data: { jobId: o.jobId, overrideId: o.id, acknowledgedBy: actor.userId } });
      } catch (e) {
        // Lost a race with another tap: the unique index on override_id decides.
        if ((e as { code?: string }).code === "P2002") throw new AppError(ERROR_CODES.OVERRIDE_ALREADY_ACKNOWLEDGED, { overrideId });
        throw e;
      }
      return {
        result: { overrideId: o.id, acknowledgedAt: ack.acknowledgedAt },
        audit: {
          action: "override.acknowledge",
          entityType: "SequenceOverride",
          entityId: o.id,
          before: { acknowledged: false },
          after: {
            acknowledged: true,
            acknowledgedBy: actor.userId,
            acknowledgedAt: ack.acknowledgedAt,
            jobId: o.jobId,
            unitId: o.unitId,
            targetKind: o.targetKind,
            targetId: o.targetId,
          },
          eventType: "override.acknowledged",
          eventPayload: { overrideId: o.id, jobId: o.jobId },
        },
      };
    });
  });
}
