import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { createDrawingRevisionSchema, type CreateDrawingRevisionInput } from "@/lib/shared/schemas";
import type { DrawingRevision } from "@/generated/prisma/client";

/**
 * Issue a new `DrawingRevision` for an `AssemblyDrawing` (B9, Phase 4).
 * Invariant #9 (versioned things are never edited in place): the prior
 * RELEASED revision on this drawing, if any, flips to SUPERSEDED in the same
 * transaction — never deleted, still queryable via `AssemblyDrawing.revisions`.
 * No maker-checker (this isn't a process transition, invariant #3 doesn't
 * apply) — same convention as `recordMtc`.
 */
export async function createDrawingRevision(
  actor: Actor,
  input: CreateDrawingRevisionInput,
): Promise<DrawingRevision> {
  const { assemblyDrawingId, revisionNo, status } = createDrawingRevisionSchema.parse(input);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const drawing = await tx.assemblyDrawing.findFirst({
      where: { id: assemblyDrawingId, job: { tenantId: actor.tenantId } },
      select: { id: true },
    });
    if (!drawing) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "AssemblyDrawing", assemblyDrawingId });

    const priorReleased = await tx.drawingRevision.findFirst({
      where: { assemblyDrawingId, status: "RELEASED" },
      select: { id: true },
    });

    return audited(tx, actor, async () => {
      if (priorReleased) {
        await tx.drawingRevision.update({ where: { id: priorReleased.id }, data: { status: "SUPERSEDED" } });
      }
      const revision = await tx.drawingRevision.create({
        data: {
          assemblyDrawingId,
          revisionNo,
          status,
          releasedAt: status === "RELEASED" ? new Date() : null,
        },
      });
      return {
        result: revision,
        audit: {
          action: "drawing.createRevision",
          entityType: "DrawingRevision",
          entityId: revision.id,
          before: priorReleased ? { supersededRevisionId: priorReleased.id } : undefined,
          after: { assemblyDrawingId, revisionNo, status, releasedAt: revision.releasedAt },
          eventType: "DrawingRevisionCreated",
          eventPayload: { assemblyDrawingId, revisionNo, status },
        },
      };
    });
  });
}
