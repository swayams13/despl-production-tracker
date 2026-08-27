import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertClientScope, assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
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
 *
 * Role gate: same production-vocabulary write as `recordProcurementEvent`/
 * `receiveStock` (ADMIN or PRODUCTION_HEAD, design-office authority is the
 * real-world analogue) — task review Critical: without this, the same
 * supervisor `assertDrawingReleased` just refused could issue their own
 * RELEASED revision and clear the gate on their own work.
 */
export async function createDrawingRevision(
  actor: Actor,
  input: CreateDrawingRevisionInput,
): Promise<DrawingRevision> {
  const { assemblyDrawingId, revisionNo, status } = createDrawingRevisionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const drawing = await tx.assemblyDrawing.findFirst({
      where: { id: assemblyDrawingId, job: { tenantId: actor.tenantId } },
      select: { id: true, job: { select: { clientId: true } } },
    });
    if (!drawing) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "AssemblyDrawing", assemblyDrawingId });
    assertClientScope(actor, drawing.job.clientId);

    // Task review Important: "current" is defined as max(revisionNo) — a
    // lower/duplicate revisionNo issued by mistake would permanently block
    // cutting on this drawing (the real RELEASED row stops being "current")
    // with no recovery path except guessing a number above the max. Refuse
    // it instead, inside the same transaction that reads the max.
    const highest = await tx.drawingRevision.findFirst({
      where: { assemblyDrawingId },
      orderBy: { revisionNo: "desc" },
      select: { revisionNo: true },
    });
    if (highest && revisionNo <= highest.revisionNo) {
      throw new AppError(ERROR_CODES.DRAWING_REVISION_NOT_INCREASING, {
        assemblyDrawingId,
        revisionNo,
        currentHighestRevisionNo: highest.revisionNo,
      });
    }

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
