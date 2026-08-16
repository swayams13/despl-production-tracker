import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { hashPassword } from "@/lib/auth/password";
import {
  createUserSchema,
  resetPasswordSchema,
  createDelayCategorySchema,
  updateDelayCategorySchema,
  updateStandardDurationsSchema,
  type CreateUserInput,
  type ResetPasswordInput,
  type CreateDelayCategoryInput,
  type UpdateDelayCategoryInput,
  type UpdateStandardDurationsInput,
} from "@/lib/shared/schemas";
import type { User, DelayCategoryRef, ProcessTemplateVersion } from "@/generated/prisma/client";

/**
 * §4.10 Admin — "minimal but real": users, master delay-reason list,
 * standard-durations table editor. Every mutation here is ADMIN-only
 * (management may view the page but performs no actions, per the Demo
 * Readiness checklist's "management sees zero action buttons anywhere") and
 * none of it is exempt from invariant #5 (append-only audit).
 */

export async function createUser(actor: Actor, input: CreateUserInput): Promise<User> {
  const { name, email, roleCodes, departmentIds, password } = createUserSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const existing = await tx.user.findFirst({ where: { tenantId: actor.tenantId, email } });
    if (existing) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { email }, "A user with this email already exists.");
    }
    const roles = await tx.role.findMany({ where: { tenantId: actor.tenantId, code: { in: roleCodes } } });
    if (roles.length !== roleCodes.length) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { roleCodes }, "One or more roles are invalid.");
    }
    if (departmentIds.length) {
      const depts = await tx.department.count({ where: { tenantId: actor.tenantId, id: { in: departmentIds } } });
      if (depts !== departmentIds.length) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { departmentIds }, "One or more departments are invalid.");
      }
    }

    const passwordHash = await hashPassword(password);

    return audited(tx, actor, async () => {
      const user = await tx.user.create({
        data: {
          tenantId: actor.tenantId,
          name,
          email,
          // ponytail: derived from email local-part, matching the migration's
          // backfill rule. Task 1.3 (password-change flow) is the one that
          // needs a real username-entry UX; this just keeps rows valid.
          username: email.split("@")[0],
          passwordHash,
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
          departments: { create: departmentIds.map((departmentId) => ({ departmentId })) },
        },
      });
      return {
        result: user,
        audit: {
          action: "admin.createUser",
          entityType: "User",
          entityId: user.id,
          after: { name, email, roleCodes, departmentIds },
          eventType: "UserCreated",
          eventPayload: { userId: user.id, email, roleCodes },
        },
      };
    });
  });
}

export async function resetUserPassword(actor: Actor, input: ResetPasswordInput): Promise<void> {
  const { userId, password } = resetPasswordSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, tenantId: actor.tenantId } });
    if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "User", userId });

    const passwordHash = await hashPassword(password);
    await audited(tx, actor, async () => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      return {
        result: undefined,
        audit: {
          action: "admin.resetPassword",
          entityType: "User",
          entityId: userId,
          eventType: "UserPasswordReset",
          eventPayload: { userId },
        },
      };
    });
  });
}

export async function createDelayCategory(actor: Actor, input: CreateDelayCategoryInput): Promise<DelayCategoryRef> {
  const { name } = createDelayCategorySchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  const code = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  return withTenant(actor.tenantId, async (tx) => {
    const existing = await tx.delayCategoryRef.findFirst({ where: { tenantId: actor.tenantId, code } });
    if (existing) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { code }, "A delay reason with this name already exists.");
    }
    return audited(tx, actor, async () => {
      const cat = await tx.delayCategoryRef.create({ data: { tenantId: actor.tenantId, code, name } });
      return {
        result: cat,
        audit: {
          action: "admin.createDelayCategory",
          entityType: "DelayCategoryRef",
          entityId: cat.id,
          after: { code, name },
          eventType: "DelayCategoryCreated",
          eventPayload: { delayCategoryId: cat.id, name },
        },
      };
    });
  });
}

export async function updateDelayCategory(actor: Actor, input: UpdateDelayCategoryInput): Promise<DelayCategoryRef> {
  const { id, name, active } = updateDelayCategorySchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const cat = await tx.delayCategoryRef.findFirst({ where: { id, tenantId: actor.tenantId } });
    if (!cat) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "DelayCategoryRef", id });

    return audited(tx, actor, async () => {
      const updated = await tx.delayCategoryRef.update({
        where: { id },
        data: { name: name ?? cat.name, active: active ?? cat.active },
      });
      return {
        result: updated,
        audit: {
          action: "admin.updateDelayCategory",
          entityType: "DelayCategoryRef",
          entityId: id,
          before: { name: cat.name, active: cat.active },
          after: { name: updated.name, active: updated.active },
          eventType: "DelayCategoryUpdated",
          eventPayload: { delayCategoryId: id },
        },
      };
    });
  });
}

/**
 * Invariant #9: a template edit creates a NEW ProcessTemplateVersion — copy
 * every process + edge from the source version, apply the batch of duration
 * edits to the copies, publish the new version. The source version (and
 * every Job already pinned to it via Job.templateVersionId) is untouched.
 */
export async function updateStandardDurations(
  actor: Actor,
  input: UpdateStandardDurationsInput,
): Promise<ProcessTemplateVersion> {
  const { templateVersionId, edits, reason } = updateStandardDurationsSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const source = await tx.processTemplateVersion.findFirst({
      where: { id: templateVersionId, template: { tenantId: actor.tenantId } },
      include: { processes: true, edges: true },
    });
    if (!source) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", templateVersionId });

    const editByProcessId = new Map(edits.map((e) => [e.templateProcessId, e]));
    const sourceProcessIds = new Set(source.processes.map((p) => p.id));
    for (const e of edits) {
      if (!sourceProcessIds.has(e.templateProcessId)) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "TemplateProcess", id: e.templateProcessId });
      }
    }

    const maxVersion = await tx.processTemplateVersion.aggregate({
      _max: { version: true },
      where: { templateId: source.templateId },
    });
    const nextVersion = (maxVersion._max.version ?? 0) + 1;

    return audited(tx, actor, async () => {
      const created = await tx.processTemplateVersion.create({
        data: {
          templateId: source.templateId,
          version: nextVersion,
          status: "PUBLISHED",
          publishedAt: new Date(),
          publishedBy: actor.userId,
          notes: reason,
        },
      });

      const oldToNewProcessId = new Map<number, number>();
      for (const p of source.processes) {
        const edit = editByProcessId.get(p.id);
        const copy = await tx.templateProcess.create({
          data: {
            versionId: created.id,
            seq: p.seq,
            code: p.code,
            name: p.name,
            mainActivities: p.mainActivities,
            durationMinDays: edit?.durationMinDays ?? p.durationMinDays,
            durationMaxDays: edit?.durationMaxDays ?? p.durationMaxDays,
            cumulativePrinted: p.cumulativePrinted,
            defaultDepartmentId: p.defaultDepartmentId,
            workOrderStages: p.workOrderStages,
            envelopeFinishByMinDays: p.envelopeFinishByMinDays,
            envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
            envelopeStartByMinDays: p.envelopeStartByMinDays,
            envelopeStartByMaxDays: p.envelopeStartByMaxDays,
            optional: p.optional,
            provisional: edit ? false : p.provisional,
          },
        });
        oldToNewProcessId.set(p.id, copy.id);
      }
      for (const e of source.edges) {
        await tx.templateEdge.create({
          data: {
            versionId: created.id,
            processId: oldToNewProcessId.get(e.processId)!,
            predecessorId: oldToNewProcessId.get(e.predecessorId)!,
            type: e.type,
            lagDays: e.lagDays,
          },
        });
      }

      return {
        result: created,
        audit: {
          action: "admin.updateStandardDurations",
          entityType: "ProcessTemplateVersion",
          entityId: created.id,
          before: { sourceVersionId: source.id },
          after: { version: nextVersion, editCount: edits.length, reason },
          eventType: "StandardDurationsUpdated",
          eventPayload: { templateId: source.templateId, newVersionId: created.id, editCount: edits.length },
        },
      };
    });
  });
}
