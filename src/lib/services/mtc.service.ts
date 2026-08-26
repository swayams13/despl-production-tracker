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
    // `bom_items` carries no tenant_id (audit C3): `assertClientScope` below
    // is a CLIENT boundary (no-ops for internal actors, authz/index.ts:124-128)
    // and was doing all the work here, which is none for the common internal
    // case. Anchor the id lookup itself through `equipment.job`, which IS
    // tenant-scoped — same pattern as `lockProcessPlanForUpdate` (_shared.ts).
    const bomItem = await tx.bomItem.findFirst({
      where: { id: bomItemId, equipment: { job: { tenantId: actor.tenantId } } },
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
