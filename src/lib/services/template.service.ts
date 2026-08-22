import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { ROLES, requireRole, assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createTemplateSchema,
  cloneVersionSchema,
  type CreateTemplateInput,
  type CloneVersionInput,
} from "@/lib/shared/schemas";
import { copyVersionContents } from "./template-copy";
import type { ProcessTemplateVersion } from "@/generated/prisma/client";

/**
 * Process route authoring (docs/superpowers/specs/2026-08-22-route-authoring-design.md).
 *
 * The discipline this file exists to enforce: a PUBLISHED
 * ProcessTemplateVersion is immutable (invariant #9). Every edit path either
 * targets a DRAFT or creates a new version — never both, never neither. Jobs
 * pin a version at creation and keep it forever, so mutating a published one
 * would silently rewrite the plan of every job already running against it.
 *
 * `updateStandardDurations` in admin.service.ts stays where it is: a narrower,
 * already-tested contract (edit durations → publish in one shot) that this
 * file's saveDraft → publish flow deliberately does not absorb.
 */

/** Start a route for a family that has none. The result is an empty v1 DRAFT. */
export async function createTemplate(
  actor: Actor,
  input: CreateTemplateInput,
): Promise<ProcessTemplateVersion> {
  const { familyId, name } = createTemplateSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const family = await tx.productFamily.findFirst({
      where: { id: familyId, tenantId: actor.tenantId },
    });
    if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId });

    return audited(tx, actor, async () => {
      const template = await tx.processTemplate.create({
        data: { tenantId: actor.tenantId, familyId, name },
      });
      const version = await tx.processTemplateVersion.create({
        data: { templateId: template.id, version: 1, status: "DRAFT" },
      });
      return {
        result: version,
        audit: {
          action: "template.create",
          entityType: "ProcessTemplateVersion",
          entityId: version.id,
          after: { templateId: template.id, familyId, name, version: 1, status: "DRAFT" },
          eventType: "ProcessTemplateCreated",
          eventPayload: { templateId: template.id, versionId: version.id, familyId },
        },
      };
    });
  });
}

/**
 * Deep-copy a version into a new DRAFT — the primary authoring path, because
 * nobody types 36 processes from a blank page.
 *
 * Durations are copied VERBATIM, including into another family. That is
 * deliberate: silently nulling them would hide the author's decision about
 * whether the source's numbers apply here. If they don't, the author must
 * change them or mark the process provisional, and the publish warning will
 * say so either way (invariant #10).
 */
export async function cloneVersion(
  actor: Actor,
  input: CloneVersionInput,
): Promise<ProcessTemplateVersion> {
  const { sourceVersionId, targetFamilyId, name, notes } = cloneVersionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const source = await tx.processTemplateVersion.findFirst({
      where: { id: sourceVersionId, template: { tenantId: actor.tenantId } },
      include: { template: true },
    });
    if (!source) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        entity: "ProcessTemplateVersion",
        sourceVersionId,
      });
    }

    let templateId = source.templateId;
    let version: number;
    if (targetFamilyId != null) {
      const family = await tx.productFamily.findFirst({
        where: { id: targetFamilyId, tenantId: actor.tenantId },
      });
      if (!family) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId: targetFamilyId });
      }
      const created = await tx.processTemplate.create({
        data: { tenantId: actor.tenantId, familyId: targetFamilyId, name: name! },
      });
      templateId = created.id;
      version = 1;
    } else {
      const max = await tx.processTemplateVersion.aggregate({
        _max: { version: true },
        where: { templateId: source.templateId },
      });
      version = (max._max.version ?? 0) + 1;
    }

    return audited(tx, actor, async () => {
      const draft = await tx.processTemplateVersion.create({
        data: { templateId, version, status: "DRAFT", notes },
      });
      const idMap = await copyVersionContents(tx, source.id, draft.id);
      return {
        result: draft,
        audit: {
          action: "template.cloneVersion",
          entityType: "ProcessTemplateVersion",
          entityId: draft.id,
          before: { sourceVersionId: source.id, sourceTemplateId: source.templateId },
          after: { templateId, version, status: "DRAFT", processCount: idMap.size, notes },
          eventType: "ProcessTemplateVersionCloned",
          eventPayload: { sourceVersionId: source.id, newVersionId: draft.id, templateId },
        },
      };
    });
  });
}
