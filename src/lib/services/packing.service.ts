import { withTenant, type Tx } from "@/lib/db";
import { type Actor, assertNotClientUser, requireRole, ROLES } from "@/lib/authz";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createPackageSchema,
  assignUnitToPackageSchema,
  type CreatePackageInput,
  type AssignUnitToPackageInput,
} from "@/lib/shared/schemas";
import type { Package, Unit } from "@/generated/prisma/client";

/**
 * D1 (Phase 5) — packages and unit-to-package assignment, the packing-list
 * grain the dispatch batch/unit workflow (dispatch.service.ts) builds on top
 * of. No state machine here — a Package has no status of its own; readiness
 * is just "does this unit have a packageId" (checked by dispatch.service.ts's
 * addUnitToBatch).
 */

/** Anchors jobId to this tenant, or throws NOT_FOUND (never trust a client-asserted jobId). */
async function assertJobInTenant(tx: Tx, jobId: number, tenantId: number): Promise<void> {
  const job = await tx.job.findFirst({ where: { id: jobId, tenantId } });
  if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });
}

export async function createPackage(actor: Actor, input: CreatePackageInput): Promise<Package> {
  const { jobId, packageNo, weightKg, lengthMm, widthMm, heightMm, preservationNotes } =
    createPackageSchema.parse(input);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    await assertJobInTenant(tx, jobId, actor.tenantId);

    return audited(tx, actor, async () => {
      const pkg = await tx.package.create({
        data: {
          jobId,
          packageNo,
          weightKg: weightKg ?? null,
          lengthMm: lengthMm ?? null,
          widthMm: widthMm ?? null,
          heightMm: heightMm ?? null,
          preservationNotes: preservationNotes ?? null,
          createdBy: actor.userId,
        },
      });
      return {
        result: pkg,
        audit: {
          action: "package.create",
          entityType: "Package",
          entityId: pkg.id,
          after: { jobId: pkg.jobId, packageNo: pkg.packageNo },
          eventType: "PackageCreated",
          eventPayload: { packageId: pkg.id, jobId },
        },
      };
    });
  });
}

/**
 * Sets `Unit.packageId`. Both must share the same job (cross-job assignment
 * refuses with CROSS_JOB_ASSIGNMENT rather than silently linking a unit into
 * another job's package) — mirrors the cross-tenant-anchoring convention:
 * both rows are first re-read tenant-scoped, then compared to each other.
 */
export async function assignUnitToPackage(actor: Actor, input: AssignUnitToPackageInput): Promise<Unit> {
  const { packageId, unitId } = assignUnitToPackageSchema.parse(input);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const pkg = await tx.package.findFirst({ where: { id: packageId, job: { tenantId: actor.tenantId } } });
    if (!pkg) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Package", packageId });

    const unit = await tx.unit.findFirst({
      where: { id: unitId, equipment: { job: { tenantId: actor.tenantId } } },
      include: { equipment: { select: { jobId: true } } },
    });
    if (!unit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Unit", unitId });

    if (unit.equipment.jobId !== pkg.jobId) {
      throw new AppError(ERROR_CODES.CROSS_JOB_ASSIGNMENT, {
        unitId,
        unitJobId: unit.equipment.jobId,
        packageId,
        packageJobId: pkg.jobId,
      });
    }

    return audited(tx, actor, async () => {
      const updated = await tx.unit.update({ where: { id: unit.id }, data: { packageId: pkg.id } });
      return {
        result: updated,
        audit: {
          action: "unit.assignToPackage",
          entityType: "Unit",
          entityId: unit.id,
          before: { packageId: unit.packageId },
          after: { packageId: updated.packageId },
          eventType: "UnitAssignedToPackage",
          eventPayload: { unitId: unit.id, packageId: pkg.id },
        },
      };
    });
  });
}
