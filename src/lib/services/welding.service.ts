import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { requireRole, requireDepartmentScope, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  logWeldJointSchema,
  recordNdtResultSchema,
  type LogWeldJointInput,
  type RecordNdtResultInput,
} from "@/lib/shared/schemas";
import type { WeldJoint, NdtResult } from "@/generated/prisma/client";

/**
 * FR-W2/W3 (welding module). This is an operational log, not a gated stage in
 * the 36→25 spine — the real seed data folds welding into the FABRICATION
 * department across several stages with no single dedicated stage to attach a
 * joint to (see schema.prisma's welding module note), so neither write here
 * carries process.service's predecessor/hold-point/delay-block gating. They
 * still go through the same transaction + audited() shape as every other
 * mutation in this codebase.
 */

async function fabricationDepartmentId(tx: Tx, tenantId: number): Promise<number> {
  const dept = await tx.department.findFirst({ where: { tenantId, code: "FABRICATION" } });
  if (!dept) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Department", code: "FABRICATION" });
  return dept.id;
}

/**
 * §4.7 "Welding supervisor can Log joints". Department-scoped like every
 * other floor mutation (requireDepartmentScope also passes PRODUCTION_HEAD/
 * ADMIN through) — there is no separate role check because department scope
 * on FABRICATION already limits this to that department's supervisor (plus
 * PH/admin), matching startProcess/submitProcess's own gate shape.
 */
export async function logWeldJoint(actor: Actor, input: LogWeldJointInput): Promise<WeldJoint> {
  const { jobId, unitId, jointNo, jointType, weldSize, wpsRef, welderIds } = logWeldJointSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const deptId = await fabricationDepartmentId(tx, actor.tenantId);
    requireDepartmentScope(actor, deptId);

    // RLS on `jobs` (tenant-root) makes this the tenant-scoping check: a
    // cross-tenant jobId resolves to zero rows rather than a leaked row.
    const job = await tx.job.findUnique({ where: { id: jobId } });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });

    if (unitId != null) {
      const unit = await tx.unit.findFirst({ where: { id: unitId, equipment: { jobId } } });
      if (!unit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Unit", unitId });
    }

    const welders = await tx.welder.findMany({ where: { id: { in: welderIds }, tenantId: actor.tenantId } });
    if (welders.length !== welderIds.length) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Welder", welderIds });
    }

    return audited(tx, actor, async () => {
      const joint = await tx.weldJoint.create({
        data: {
          jobId,
          unitId: unitId ?? null,
          jointNo,
          jointType,
          weldSize: weldSize ?? null,
          wpsRef: wpsRef ?? null,
          loggedBy: actor.userId,
          welders: { create: welderIds.map((welderId) => ({ welderId })) },
        },
      });
      return {
        result: joint,
        audit: {
          action: "welding.logJoint",
          entityType: "WeldJoint",
          entityId: joint.id,
          after: { jobId, unitId: unitId ?? null, jointNo, jointType, welderIds },
          eventType: "WeldJointLogged",
          eventPayload: { weldJointId: joint.id, jobId, jointNo, welderIds },
        },
      };
    });
  });
}

/**
 * FR-W3 "NDT/QC can record results". QC-role-gated, no department scope —
 * matches recordQcpExecution's exact shape (QC is not department-scoped in
 * this app; recording an inspection result is inherently a QC act).
 */
export async function recordNdtResult(actor: Actor, input: RecordNdtResultInput): Promise<NdtResult> {
  const { weldJointId, testTypeId, result } = recordNdtResultSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC);

  return withTenant(actor.tenantId, async (tx) => {
    const joint = await tx.weldJoint.findFirst({
      where: { id: weldJointId, job: { tenantId: actor.tenantId } },
    });
    if (!joint) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "WeldJoint", weldJointId });

    return audited(tx, actor, async () => {
      const ndt = await tx.ndtResult.create({
        data: {
          weldJointId,
          testTypeId,
          result,
          recordedBy: actor.userId,
          // SERVER CLOCK ONLY (invariant #1).
          recordedAt: new Date(),
        },
      });
      return {
        result: ndt,
        audit: {
          action: "welding.recordNdt",
          entityType: "NdtResult",
          entityId: ndt.id,
          after: { weldJointId, testTypeId, result },
          eventType: "NdtResultRecorded",
          eventPayload: { ndtResultId: ndt.id, weldJointId, result },
        },
      };
    });
  });
}
