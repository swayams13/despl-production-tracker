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
  const { bomItemId, componentId, heatNumber, mtcRef, pmiResult, qtyIssued } = recordMtcSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC);

  return withTenant(actor.tenantId, async (tx) => {
    // `bom_items` carries no tenant_id (audit C3): `assertClientScope` below
    // is a CLIENT boundary (no-ops for internal actors, authz/index.ts:124-128)
    // and was doing all the work here, which is none for the common internal
    // case. Anchor the id lookup itself through `equipment.job`, which IS
    // tenant-scoped — same pattern as `lockProcessPlanForUpdate` (_shared.ts).
    //
    // B8: `bomItemId` is ALWAYS independently verified against the actor's
    // tenant, regardless of whether `componentId` is also supplied — task
    // review (round 2) caught that skipping this when `componentId` was
    // present let a same-tenant `componentId` legitimize an attacker-guessed
    // `bomItemId` belonging to a different tenant (autoincrement PK, no RLS
    // on `material_identifications` itself). When `componentId` IS supplied,
    // it gets its own independent tenant check too (same shape, different
    // join root) — both ids must resolve inside this tenant before the row
    // is created.
    const bomItem = await tx.bomItem.findFirst({
      where: { id: bomItemId, equipment: { job: { tenantId: actor.tenantId } } },
      select: { equipment: { select: { job: { select: { clientId: true } } } } },
    });
    if (!bomItem) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomItem", bomItemId });
    let clientId = bomItem.equipment.job.clientId;

    if (componentId != null) {
      const component = await tx.component.findFirst({
        where: { id: componentId, equipment: { job: { tenantId: actor.tenantId } } },
        select: { equipment: { select: { job: { select: { clientId: true } } } } },
      });
      if (!component) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Component", componentId });
      clientId = component.equipment.job.clientId;
    }
    assertClientScope(actor, clientId);

    return audited(tx, actor, async () => {
      const record = await tx.materialIdentification.create({
        data: { bomItemId, componentId: componentId ?? null, heatNumber, mtcRef: mtcRef ?? null, pmiResult, qtyIssued: qtyIssued ?? null },
      });
      return {
        result: record,
        audit: {
          action: "mtc.record",
          entityType: "MaterialIdentification",
          entityId: record.id,
          after: { bomItemId, componentId: componentId ?? null, heatNumber, mtcRef: mtcRef ?? null, pmiResult, qtyIssued: qtyIssued ?? null },
          eventType: "MtcRecorded",
          eventPayload: { bomItemId, componentId: componentId ?? null, heatNumber, pmiResult },
        },
      };
    });
  });
}
