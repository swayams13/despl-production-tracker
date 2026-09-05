import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { ROLES, requireRole, assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createOrReviseRouteTemplateSchema,
  setOperationRefFamilySeqSchema,
  type CreateOrReviseRouteTemplateInput,
  type SetOperationRefFamilySeqInput,
} from "@/lib/shared/schemas";
import type { RouteTemplateVersion, OperationRefFamilySeq } from "@/generated/prisma/client";

/**
 * Component-level route authoring (C6).
 *
 * Distinct from `template.service.ts` (which authors `ProcessTemplate`, the
 * job/unit-grain 36-process spine): a `RouteTemplate` is the per-component
 * operation route consumed by `component.service.ts`'s
 * `materializeComponentsFromBomItems`. Unlike `ProcessTemplate`,
 * `RouteTemplateVersion` has no DRAFT stage in practice — every existing
 * writer (`prisma/seed.ts`, `scripts/split-plate-rolling-forming.ts`) creates
 * it PUBLISHED immediately, so revising a route just creates a new PUBLISHED
 * version outright (invariant #9: the old version is never mutated in place,
 * so a `Component` already pinned to it via `routeVersionId` keeps rendering
 * against it unchanged).
 */

/**
 * Create a new `RouteTemplate` for (componentTypeId, familyId), or — if one
 * already exists for that pair — add a new PUBLISHED version to it.
 */
export async function createOrReviseRouteTemplate(
  actor: Actor,
  input: CreateOrReviseRouteTemplateInput,
): Promise<RouteTemplateVersion> {
  const { componentTypeId, familyId, name, printedRoute, steps } =
    createOrReviseRouteTemplateSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  const seqs = new Set<number>();
  for (const s of steps) {
    if (seqs.has(s.seq)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "duplicate step sequence", seq: s.seq });
    }
    seqs.add(s.seq);
  }

  return withTenant(actor.tenantId, async (tx) => {
    const componentType = await tx.componentTypeRef.findFirst({
      where: { id: componentTypeId, tenantId: actor.tenantId },
    });
    if (!componentType) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ComponentTypeRef", componentTypeId });
    }
    if (familyId != null) {
      const family = await tx.productFamily.findFirst({ where: { id: familyId, tenantId: actor.tenantId } });
      if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId });
    }

    const givenOperationIds = steps.map((s) => s.operationId).filter((v): v is number => v != null);
    if (givenOperationIds.length > 0) {
      const found = await tx.operationRef.count({
        where: { id: { in: [...new Set(givenOperationIds)] }, tenantId: actor.tenantId },
      });
      if (found !== new Set(givenOperationIds).size) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "OperationRef", operationRefIds: givenOperationIds });
      }
    }

    // Look-up-or-create every inline newOperation, by (tenantId, code) — a
    // tenant-wide catalog, never duplicated across routes.
    const resolvedOperationIdByStepIndex = new Map<number, number>();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.operationId != null) {
        resolvedOperationIdByStepIndex.set(i, step.operationId);
        continue;
      }
      const spec = step.newOperation!;
      const existing = await tx.operationRef.findFirst({
        where: { tenantId: actor.tenantId, code: spec.code },
      });
      const opId =
        existing?.id ??
        (
          await tx.operationRef.create({
            data: {
              tenantId: actor.tenantId,
              code: spec.code,
              name: spec.name,
              defaultDepartmentId: spec.defaultDepartmentId,
              sourceColumn: spec.sourceColumn,
            },
          })
        ).id;
      resolvedOperationIdByStepIndex.set(i, opId);
    }

    // familyId can be null, and Prisma's generated composite-unique lookup
    // type does not accept null cleanly for a nullable compound-unique
    // field — a plain findFirst on the same columns always works instead.
    const existingRoute = await tx.routeTemplate.findFirst({
      where: { tenantId: actor.tenantId, componentTypeId, familyId },
    });

    return audited(tx, actor, async () => {
      let routeId: number;
      let newVersion: number;
      if (existingRoute) {
        routeId = existingRoute.id;
        const max = await tx.routeTemplateVersion.aggregate({
          _max: { version: true },
          where: { routeId },
        });
        newVersion = (max._max.version ?? 0) + 1;
      } else {
        const created = await tx.routeTemplate.create({
          data: { tenantId: actor.tenantId, componentTypeId, familyId, name },
        });
        routeId = created.id;
        newVersion = 1;
      }

      let effectivePrintedRoute = printedRoute ?? null;
      if (effectivePrintedRoute == null && existingRoute) {
        const previous = await tx.routeTemplateVersion.findFirst({
          where: { routeId },
          orderBy: { version: "desc" },
          select: { printedRoute: true },
        });
        effectivePrintedRoute = previous?.printedRoute ?? null;
      }

      const version = await tx.routeTemplateVersion.create({
        data: { routeId, version: newVersion, status: "PUBLISHED", printedRoute: effectivePrintedRoute },
      });

      await tx.routeStep.createMany({
        data: steps.map((s, i) => ({
          routeVersionId: version.id,
          seq: s.seq,
          operationId: resolvedOperationIdByStepIndex.get(i)!,
          printed: s.printed,
          optional: s.optional,
        })),
      });

      return {
        result: version,
        audit: {
          action: "route.createOrRevise",
          entityType: "RouteTemplateVersion",
          entityId: version.id,
          before: existingRoute ? { componentTypeId, familyId } : undefined,
          after: { componentTypeId, familyId, stepCount: steps.length, newVersion },
          eventType: "RouteTemplateVersionPublished",
          eventPayload: { routeId, versionId: version.id, componentTypeId, familyId },
        },
      };
    });
  });
}

/**
 * Sets which of a family's own published `TemplateProcess.seq` values an
 * `OperationRef` rolls up into — the Gate 3 fix's authoring path. Refuses
 * `ROUTE_STEP_SEQ_UNKNOWN` unless the number is one of that family's own
 * latest published route's process sequence numbers; this is the whole
 * point of the family-scoping (see `OperationRefFamilySeq`'s doc comment
 * in schema.prisma) — a stale or foreign number must never be accepted.
 */
export async function setOperationRefFamilySeq(
  actor: Actor,
  input: SetOperationRefFamilySeqInput,
): Promise<OperationRefFamilySeq> {
  const { operationRefId, familyId, leadTimeProcessSeq } = setOperationRefFamilySeqSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const operationRef = await tx.operationRef.findFirst({
      where: { id: operationRefId, tenantId: actor.tenantId },
    });
    if (!operationRef) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "OperationRef", operationRefId });
    }
    const family = await tx.productFamily.findFirst({ where: { id: familyId, tenantId: actor.tenantId } });
    if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId });

    const latestPublished = await tx.processTemplateVersion.findFirst({
      where: { status: "PUBLISHED", template: { familyId } },
      orderBy: { version: "desc" },
      include: { processes: { select: { seq: true } } },
    });
    const knownSeqs = latestPublished?.processes.map((p) => p.seq) ?? [];
    if (!knownSeqs.includes(leadTimeProcessSeq)) {
      throw new AppError(ERROR_CODES.ROUTE_STEP_SEQ_UNKNOWN, {
        familyId,
        familyName: family.name,
        leadTimeProcessSeq,
      });
    }

    const existing = await tx.operationRefFamilySeq.findFirst({ where: { operationRefId, familyId } });

    return audited(tx, actor, async () => {
      const row = existing
        ? await tx.operationRefFamilySeq.update({
            where: { id: existing.id },
            data: { leadTimeProcessSeq },
          })
        : await tx.operationRefFamilySeq.create({
            data: { tenantId: actor.tenantId, operationRefId, familyId, leadTimeProcessSeq },
          });

      return {
        result: row,
        audit: {
          action: "route.setOperationRefFamilySeq",
          entityType: "OperationRefFamilySeq",
          entityId: row.id,
          before: existing ? { leadTimeProcessSeq: existing.leadTimeProcessSeq } : undefined,
          after: { leadTimeProcessSeq },
          eventType: "OperationRefFamilySeqSet",
          eventPayload: { operationRefId, familyId, leadTimeProcessSeq },
        },
      };
    });
  });
}
