import { withTenant } from "@/lib/db";
import { assertNotClientUser, requireDepartmentScope, type Actor } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { NUDGE_COOLDOWN_MINUTES } from "@/lib/shared/constants";
import { notify, userIdsWithRole } from "./notifications.service";
import { createWeldJointTx } from "./welding.service";

/**
 * Lean Core L2.2: the two writes the Floor screen needs beside recordWork.
 * Both are thin and audited; neither changes an item's status.
 */

/** The roles a refusal card may ask for help from. */
const NUDGE_ROLES = ["QC", "STORES", "ENGINEERING", "PRODUCTION_HEAD"] as const;
export type NudgeRole = (typeof NUDGE_ROLES)[number];

export interface NotifyBlockerInput {
  unitPublicId: string;
  kind: "ASSEMBLY_STEP" | "COMPONENT_OP";
  id: number;
  role: NudgeRole;
}

/**
 * "Notify QC" on a refusal card: an in-app notification to everyone holding
 * the role that can clear it. Same cooldown and shape as nudgeQc; no external
 * channel before L2.11/L4.4.
 */
export async function notifyBlocker(actor: Actor, input: NotifyBlockerInput): Promise<{ recipients: number }> {
  assertNotClientUser(actor);
  if (!NUDGE_ROLES.includes(input.role)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { field: "role" }, "That role cannot be notified from here.");
  }
  return withTenant(actor.tenantId, async (tx) => {
    const unit = await tx.unit.findUnique({
      where: { publicId: input.unitPublicId },
      select: { id: true, serialNo: true, jobId: true, job: { select: { jobNumber: true } } },
    });
    if (!unit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Unit" });

    const target =
      input.kind === "ASSEMBLY_STEP"
        ? await tx.assemblyStep
            // j5c: history (found, then refused if retired)
            .findFirst({
              where: { id: input.id, unitId: unit.id },
              select: { retiredAt: true, templateStep: { select: { activity: true } } },
            })
            .then((s) => (s ? { retiredAt: s.retiredAt, title: s.templateStep.activity } : null))
        : await tx.componentOperation
            // j5c: history
            .findFirst({
              where: { id: input.id, component: { unitId: unit.id } },
              select: { retiredAt: true, operation: { select: { name: true } } },
            })
            .then((o) => (o ? { retiredAt: o.retiredAt, title: o.operation.name } : null));
    if (!target?.title) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: input.kind, id: input.id });
    if (target.retiredAt) throw new AppError(ERROR_CODES.FLOOR_ROW_RETIRED, { entity: input.kind, id: input.id });
    const title = target.title;

    const last = await tx.notification.findFirst({
      where: {
        type: "FLOOR_NUDGE",
        entityType: input.kind,
        entityId: input.id,
        payload: { path: ["actorId"], equals: actor.userId },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < NUDGE_COOLDOWN_MINUTES * 60_000) {
      throw new AppError(ERROR_CODES.NUDGE_COOLDOWN, { cooldownMinutes: NUDGE_COOLDOWN_MINUTES });
    }

    const recipients = await userIdsWithRole(tx, actor.tenantId, input.role);
    if (recipients.length === 0) return { recipients: 0 };
    await notify(
      tx,
      actor.tenantId,
      recipients.map((recipientId) => ({
        recipientId,
        type: "FLOOR_NUDGE",
        entityType: input.kind,
        entityId: input.id,
        title: `${actor.name} is waiting on you — Unit ${unit.serialNo}`,
        body: `${title} · ${unit.job.jobNumber}`,
        payload: { jobId: unit.jobId, unitId: unit.id, actorId: actor.userId, role: input.role },
      })),
    );
    await recordAudit(tx, actor, {
      action: "floor.notifyBlocker",
      entityType: input.kind === "ASSEMBLY_STEP" ? "AssemblyStep" : "ComponentOperation",
      entityId: input.id,
      after: { role: input.role, recipients: recipients.length },
    });
    return { recipients: recipients.length };
  });
}

/** Joint type words for the floor, from the printed weld-map reference (LS-1, CS-2, N3 ...). */
export function jointTypeOf(jointNo: string): string {
  const head = jointNo.trim().toUpperCase();
  if (head.startsWith("LS")) return "Long seam";
  if (head.startsWith("CS")) return "Circumferential seam";
  if (head.startsWith("N")) return "Nozzle weld";
  return "Weld joint";
}

export interface EnsureJointInput {
  assemblyStepId: number;
  /** Required only when the joint is not yet logged on this unit. */
  welderIds?: number[];
}

/**
 * recordWork refuses a Done on a step whose template names a joint until a
 * WeldJoint is bound (JOINT_REQUIRED), and refuses `newJoint` in a batch. This
 * resolves the joint for the Floor sheet: the unit's joint of that number if
 * it is already logged (another step of the group logged it), else a new one
 * with the welders the sheet picked. Department scope is the step's own.
 */
export async function ensureJointForStep(actor: Actor, input: EnsureJointInput): Promise<{ weldJointId: number; created: boolean }> {
  assertNotClientUser(actor);
  return withTenant(actor.tenantId, async (tx) => {
    // j5c: history (found, then refused if retired)
    const step = await tx.assemblyStep.findFirst({
      where: { id: input.assemblyStepId },
      select: {
        id: true,
        retiredAt: true,
        jobId: true,
        unitId: true,
        jointRef: true,
        plannedJointId: true,
        templateStep: { select: { jointRef: true, defaultDepartmentId: true } },
      },
    });
    if (!step) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "AssemblyStep", id: input.assemblyStepId });
    if (step.retiredAt) throw new AppError(ERROR_CODES.FLOOR_ROW_RETIRED, { entity: "AssemblyStep", id: input.assemblyStepId });
    requireDepartmentScope(actor, step.templateStep.defaultDepartmentId);
    const jointNo = (step.templateStep.jointRef ?? step.jointRef)?.trim();
    if (!jointNo) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { assemblyStepId: step.id }, "This step does not name a joint.");
    }

    const existing = await tx.weldJoint.findFirst({
      where: { jobId: step.jobId, unitId: step.unitId, jointNo },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (existing) return { weldJointId: existing.id, created: false };

    const welderIds = [...new Set(input.welderIds ?? [])];
    if (welderIds.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { field: "welderIds" }, "Pick the welder who did this joint.");
    }
    const joint = await createWeldJointTx(tx, actor, step.jobId, step.unitId, null, {
      jointNo,
      jointType: jointTypeOf(jointNo),
      welderIds,
    }, step.plannedJointId);
    await recordAudit(tx, actor, {
      action: "welding.logJoint",
      entityType: "WeldJoint",
      entityId: joint.id,
      after: { jobId: step.jobId, unitId: step.unitId, jointNo, welderIds, via: "floor" },
      eventType: "WeldJointLogged",
      eventPayload: { weldJointId: joint.id, jobId: step.jobId, jointNo, welderIds },
    });
    return { weldJointId: joint.id, created: true };
  });
}
