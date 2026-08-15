import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertClientScope, requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { recordMtcSchema, type RecordMtcInput } from "@/lib/shared/schemas";
import type { MaterialIdentification } from "@/generated/prisma/client";

/**
 * Record a heat number + MTC ref + PMI result for a BOM item (§4.3 "MTC
 * status editable by QC"). The live seed has zero `MaterialIdentification`
 * rows (the source CSVs never carried heat traceability — see the schema
 * comment on the model) — every recorded row here is a first, real entry,
 * not an update to fabricated data. QC-role-gated like `recordQcpExecution`;
 * no maker-checker (this isn't a process transition, invariant #3 doesn't
 * apply) and no correction/versioning flow (invariant #6 governs workflow
 * state, not a traceability field with no such requirement in the spec).
 */
export async function recordMtc(actor: Actor, input: RecordMtcInput): Promise<MaterialIdentification> {
  const { bomItemId, heatNumber, mtcRef, pmiResult } = recordMtcSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC);

  return withTenant(actor.tenantId, async (tx) => {
    const bomItem = await tx.bomItem.findUnique({
      where: { id: bomItemId },
      select: { equipment: { select: { job: { select: { clientId: true } } } } },
    });
    if (!bomItem) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomItem", bomItemId });
    assertClientScope(actor, bomItem.equipment.job.clientId);

    return audited(tx, actor, async () => {
      const record = await tx.materialIdentification.create({
        data: { bomItemId, heatNumber, mtcRef: mtcRef ?? null, pmiResult },
      });
      return {
        result: record,
        audit: {
          action: "mtc.record",
          entityType: "MaterialIdentification",
          entityId: record.id,
          after: { bomItemId, heatNumber, mtcRef: mtcRef ?? null, pmiResult },
          eventType: "MtcRecorded",
          eventPayload: { bomItemId, heatNumber, pmiResult },
        },
      };
    });
  });
}
