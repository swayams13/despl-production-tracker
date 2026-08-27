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
 * Tenant-scoped existence check for the performedByWelderId/performedByUserId
 * pair components carry (schema.prisma's Component/AssemblyStep comment) —
 * shared by component.service.ts's submitComponentOperation and
 * assembly.service.ts's submitAssemblyStep, the two other write paths that
 * accept these fields straight from client input. Mirrors the tenant check
 * createWeldJointTx already does for welderIds; those two callers had none.
 */
export async function assertPerformedByValid(
  tx: Tx,
  actor: Actor,
  performedByWelderId: number | null | undefined,
  performedByUserId: number | null | undefined,
): Promise<void> {
  if (performedByWelderId != null) {
    const welder = await tx.welder.findFirst({ where: { id: performedByWelderId, tenantId: actor.tenantId } });
    if (!welder) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Welder", welderId: performedByWelderId });
  }
  if (performedByUserId != null) {
    const user = await tx.user.findFirst({ where: { id: performedByUserId, tenantId: actor.tenantId } });
    if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "User", userId: performedByUserId });
  }
}

export interface CreateWeldJointFields {
  jointNo: string;
  jointType: string;
  weldSize?: string | null;
  wpsRef?: string | null;
  welderIds: number[];
}

/**
 * The joint-creation write, factored out so assembly.service.ts's
 * submitAssemblyStep (Phase 2, A6) can create a joint inline for a WORK weld
 * step without duplicating this validation. Tenant-scoping, welder
 * existence and the actual insert only — no department check and no
 * audited() wrapper, both of which differ by caller (logWeldJoint's own
 * FABRICATION-department gate vs. an assembly step's own template-derived
 * department; "welding.logJoint" vs "assembly.submitStep" as the audit
 * action).
 */
export async function createWeldJointTx(
  tx: Tx,
  actor: Actor,
  jobId: number,
  unitId: number | null,
  componentId: number | null,
  fields: CreateWeldJointFields,
): Promise<WeldJoint> {
  // RLS on `jobs` (tenant-root) makes this the tenant-scoping check: a
  // cross-tenant jobId resolves to zero rows rather than a leaked row.
  const job = await tx.job.findUnique({ where: { id: jobId } });
  if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });

  if (unitId != null) {
    const unit = await tx.unit.findFirst({ where: { id: unitId, equipment: { jobId } } });
    if (!unit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Unit", unitId });
  }

  if (componentId != null) {
    const component = await tx.component.findFirst({ where: { id: componentId, equipment: { jobId } } });
    if (!component) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Component", componentId });
  }

  const welders = await tx.welder.findMany({ where: { id: { in: fields.welderIds }, tenantId: actor.tenantId } });
  if (welders.length !== fields.welderIds.length) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Welder", welderIds: fields.welderIds });
  }

  return tx.weldJoint.create({
    data: {
      jobId,
      unitId: unitId ?? null,
      componentId: componentId ?? null,
      jointNo: fields.jointNo,
      jointType: fields.jointType,
      weldSize: fields.weldSize ?? null,
      wpsRef: fields.wpsRef ?? null,
      loggedBy: actor.userId,
      welders: { create: fields.welderIds.map((welderId) => ({ welderId })) },
    },
  });
}

/**
 * §4.7 "Welding supervisor can Log joints". Department-scoped like every
 * other floor mutation (requireDepartmentScope also passes PRODUCTION_HEAD/
 * ADMIN through) — there is no separate role check because department scope
 * on FABRICATION already limits this to that department's supervisor (plus
 * PH/admin), matching startProcess/submitProcess's own gate shape.
 */
export async function logWeldJoint(actor: Actor, input: LogWeldJointInput): Promise<WeldJoint> {
  const { jobId, unitId, componentId, jointNo, jointType, weldSize, wpsRef, welderIds } =
    logWeldJointSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const deptId = await fabricationDepartmentId(tx, actor.tenantId);
    requireDepartmentScope(actor, deptId);

    return audited(tx, actor, async () => {
      const joint = await createWeldJointTx(tx, actor, jobId, unitId ?? null, componentId ?? null, {
        jointNo,
        jointType,
        weldSize,
        wpsRef,
        welderIds,
      });
      return {
        result: joint,
        audit: {
          action: "welding.logJoint",
          entityType: "WeldJoint",
          entityId: joint.id,
          after: { jobId, unitId: unitId ?? null, componentId: componentId ?? null, jointNo, jointType, welderIds },
          eventType: "WeldJointLogged",
          eventPayload: { weldJointId: joint.id, jobId, jointNo, welderIds },
        },
      };
    });
  });
}

/**
 * The NDT-result write, factored out so assembly.service.ts's
 * rejectAssemblyStep (Phase 2, A6) can record a REJECT result against a
 * step's bound joint in the same transaction as the reject, without nesting
 * a second withTenant()/audited() pair inside the first. No role check here
 * — both callers (recordNdtResult below, rejectAssemblyStep) already
 * enforce QC before reaching this point.
 */
export async function recordNdtResultTx(
  tx: Tx,
  actor: Actor,
  weldJointId: number,
  testTypeId: number,
  result: "PENDING" | "ACCEPT" | "REJECT",
): Promise<NdtResult> {
  const joint = await tx.weldJoint.findFirst({
    where: { id: weldJointId, job: { tenantId: actor.tenantId } },
  });
  if (!joint) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "WeldJoint", weldJointId });

  return tx.ndtResult.create({
    data: {
      weldJointId,
      testTypeId,
      result,
      recordedBy: actor.userId,
      // SERVER CLOCK ONLY (invariant #1).
      recordedAt: new Date(),
    },
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
    return audited(tx, actor, async () => {
      const ndt = await recordNdtResultTx(tx, actor, weldJointId, testTypeId, result);
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
