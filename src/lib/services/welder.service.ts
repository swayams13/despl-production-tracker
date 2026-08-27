import { withTenant } from "@/lib/db";
import { requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createWelderSchema,
  updateWelderSchema,
  type CreateWelderInput,
  type UpdateWelderInput,
} from "@/lib/shared/schemas";
import type { Welder } from "@/generated/prisma/client";

/**
 * Welder registry CRUD (Phase 2 — A5). `Welder` (schema.prisma) previously
 * had no write path at all — seedable only (addendum §2). Gated the same as
 * `createEquipmentType`/`updateEquipmentType` (admin.service.ts): ADMIN or
 * PRODUCTION_HEAD, not ADMIN-only — this is production's own vocabulary
 * (who welds), not a system setting.
 *
 * No `deleteWelder` — deactivate only (`active: false`), never a hard
 * delete: `ComponentOperation.performedByWelderId`, `AssemblyStep.
 * performedByWelderId` and `WeldJointWelder` all reference welders, and
 * invariant #6 (no destructive edits) applies to reference data the same as
 * transactional data.
 */

export async function createWelder(actor: Actor, input: CreateWelderInput): Promise<Welder> {
  const { name, employeeCode, departmentId } = createWelderSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    if (departmentId != null) {
      const dept = await tx.department.findFirst({ where: { id: departmentId, tenantId: actor.tenantId } });
      if (!dept) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Department", departmentId });
    }

    const existing = await tx.welder.findFirst({ where: { tenantId: actor.tenantId, employeeCode } });
    if (existing) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { employeeCode },
        "A welder with this employee code already exists.",
      );
    }

    return audited(tx, actor, async () => {
      const welder = await tx.welder.create({
        data: { tenantId: actor.tenantId, name, employeeCode, departmentId },
      });
      return {
        result: welder,
        audit: {
          action: "welder.create",
          entityType: "Welder",
          entityId: welder.id,
          after: { name, employeeCode, departmentId },
          eventType: "WelderCreated",
          eventPayload: { welderId: welder.id, employeeCode },
        },
      };
    });
  });
}

export async function updateWelder(actor: Actor, input: UpdateWelderInput): Promise<Welder> {
  const { id, name, employeeCode, departmentId, active } = updateWelderSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const welder = await tx.welder.findFirst({ where: { id, tenantId: actor.tenantId } });
    if (!welder) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Welder", welderId: id });

    if (departmentId != null) {
      const dept = await tx.department.findFirst({ where: { id: departmentId, tenantId: actor.tenantId } });
      if (!dept) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Department", departmentId });
    }

    if (employeeCode != null && employeeCode !== welder.employeeCode) {
      const clash = await tx.welder.findFirst({
        where: { tenantId: actor.tenantId, employeeCode, id: { not: id } },
      });
      if (clash) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          { employeeCode },
          "A welder with this employee code already exists.",
        );
      }
    }

    return audited(tx, actor, async () => {
      const updated = await tx.welder.update({
        where: { id },
        data: {
          name: name ?? undefined,
          employeeCode: employeeCode ?? undefined,
          departmentId: departmentId === undefined ? undefined : departmentId,
          active: active ?? undefined,
        },
      });
      return {
        result: updated,
        audit: {
          action: "welder.update",
          entityType: "Welder",
          entityId: welder.id,
          before: { name: welder.name, employeeCode: welder.employeeCode, departmentId: welder.departmentId, active: welder.active },
          after: { name: updated.name, employeeCode: updated.employeeCode, departmentId: updated.departmentId, active: updated.active },
          eventType: "WelderUpdated",
          eventPayload: { welderId: welder.id },
        },
      };
    });
  });
}
