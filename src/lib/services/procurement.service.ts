import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertClientScope, assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { recordProcurementEventSchema, type RecordProcurementEventInput } from "@/lib/shared/schemas";
import type { ProcurementEvent } from "@/generated/prisma/client";

/**
 * Log a procurement event against a BOM item (B5, Phase 4) — append-only,
 * replacing the old mutable `Procurement` row. Production-vocabulary write,
 * same role gate as `createEquipmentType` (admin.service.ts): ADMIN or
 * PRODUCTION_HEAD, not a new role.
 *
 * No update/delete counterpart exists here or anywhere else in `src/` —
 * append-only by construction. Tenant-anchored through
 * `equipment.job.tenantId`, exactly `recordMtc`'s pattern (bom_items carries
 * no tenant_id of its own).
 */
export async function recordProcurementEvent(
  actor: Actor,
  input: RecordProcurementEventInput,
): Promise<ProcurementEvent> {
  const { bomItemId, type, qty, refNo } = recordProcurementEventSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const bomItem = await tx.bomItem.findFirst({
      where: { id: bomItemId, equipment: { job: { tenantId: actor.tenantId } } },
      select: { equipment: { select: { job: { select: { clientId: true, id: true } } } } },
    });
    if (!bomItem) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomItem", bomItemId });
    // Consistency with every sibling service (mtc/stock/drawing) — a no-op
    // today since `assertNotClientUser` above already refuses every client
    // actor before this point, but matching the pattern here.
    assertClientScope(actor, bomItem.equipment.job.clientId);

    return audited(tx, actor, async () => {
      const record = await tx.procurementEvent.create({
        data: { bomItemId, type, qty: qty ?? null, refNo: refNo ?? null, by: actor.userId, jobId: bomItem.equipment.job.id },
      });
      return {
        result: record,
        audit: {
          action: "procurement.recordEvent",
          entityType: "ProcurementEvent",
          entityId: record.id,
          after: { bomItemId, type, qty: qty ?? null, refNo: refNo ?? null },
          eventType: "ProcurementEventRecorded",
          eventPayload: { bomItemId, type, qty: qty ?? null },
        },
      };
    });
  });
}
