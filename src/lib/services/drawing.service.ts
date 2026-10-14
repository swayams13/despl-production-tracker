import { withJob, withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertClientScope, assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createDrawingRevisionSchema,
  releaseDrawingAtRiskSchema,
  type CreateDrawingRevisionInput,
  type ReleaseDrawingAtRiskInput,
} from "@/lib/shared/schemas";
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
  const { jobId, assemblyDrawingId, revisionNo, status } = createDrawingRevisionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    // H1: filter by the caller's declared jobId, not just tenantId — an
    // assemblyDrawingId from a different job in the SAME tenant must be
    // refused, not silently accepted (same pattern as
    // component.service.ts's linkGoverningDrawing).
    const drawing = await tx.assemblyDrawing.findFirst({
      where: { id: assemblyDrawingId, jobId, job: { tenantId: actor.tenantId } },
      select: { id: true, job: { select: { clientId: true, id: true } } },
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
      select: { id: true, revisionNo: true, status: true, atRiskReleasedAt: true },
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

    // L1.2c: an at-risk release belongs to one revision; this newer one voids it.
    const voidedAtRisk = highest?.atRiskReleasedAt && highest.status !== "RELEASED" ? highest.id : undefined;

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
          jobId: drawing.job.id,
        },
      });
      return {
        result: revision,
        audit: {
          action: "drawing.createRevision",
          entityType: "DrawingRevision",
          entityId: revision.id,
          before: priorReleased || voidedAtRisk ? { supersededRevisionId: priorReleased?.id, voidedAtRiskReleaseOfRevisionId: voidedAtRisk } : undefined,
          after: { assemblyDrawingId, revisionNo, status, releasedAt: revision.releasedAt },
          eventType: "DrawingRevisionCreated",
          eventPayload: { assemblyDrawingId, revisionNo, status },
        },
      };
    });
  });
}

/**
 * L1.2c (D2, H3): release the drawing's CURRENT, not-yet-RELEASED revision at
 * risk so pressure-part cutting may start before the revision is formally
 * released. PRODUCTION_HEAD only (not ADMIN), with a mandatory reason and an
 * optional client-consent reference, recorded on the revision row and audited.
 * It is voided by a newer revision: the at-risk fields live on one revision
 * row, and `assertDrawingReleased` reads only the highest revisionNo.
 */
export async function releaseDrawingAtRisk(actor: Actor, input: ReleaseDrawingAtRiskInput): Promise<DrawingRevision> {
  const { jobId, drawingRevisionId, reason, clientConsentRef } = releaseDrawingAtRiskSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.PRODUCTION_HEAD);

  return withJob(actor.tenantId, jobId, async (tx) => {
    const revision = await tx.drawingRevision.findFirst({
      where: { id: drawingRevisionId, jobId, tenantId: actor.tenantId },
      select: { id: true, assemblyDrawingId: true, revisionNo: true, status: true, atRiskReleasedAt: true },
    });
    if (!revision) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "DrawingRevision", drawingRevisionId });

    const highest = await tx.drawingRevision.findFirst({
      where: { assemblyDrawingId: revision.assemblyDrawingId },
      orderBy: { revisionNo: "desc" },
      select: { revisionNo: true },
    });
    const refuse = (why: string) =>
      new AppError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        { drawingRevisionId, currentStatus: revision.status, reason: why },
        `This revision cannot be released at risk: ${why}.`,
      );
    if (revision.status === "RELEASED") throw refuse("it is already released");
    if (highest && revision.revisionNo < highest.revisionNo) throw refuse("a newer revision exists");
    if (revision.atRiskReleasedAt) throw refuse("it was already released at risk");

    return audited(tx, actor, async () => {
      // Guarded write: the at-risk fields are set once, never overwritten.
      const claimed = await tx.drawingRevision.updateMany({
        where: { id: revision.id, atRiskReleasedAt: null },
        data: {
          atRiskReleasedById: actor.userId,
          atRiskReleasedAt: new Date(),
          atRiskReason: reason,
          clientConsentRef: clientConsentRef ?? null,
        },
      });
      if (claimed.count !== 1) throw refuse("it was already released at risk");
      const updated = await tx.drawingRevision.findUniqueOrThrow({ where: { id: revision.id } });
      return {
        result: updated,
        audit: {
          action: "drawing.releaseAtRisk",
          entityType: "DrawingRevision",
          entityId: revision.id,
          before: { status: revision.status, atRiskReleasedAt: null },
          after: {
            assemblyDrawingId: revision.assemblyDrawingId,
            revisionNo: revision.revisionNo,
            atRiskReleasedById: actor.userId,
            atRiskReleasedAt: updated.atRiskReleasedAt,
            reason,
            clientConsentRef: clientConsentRef ?? null,
          },
          eventType: "DrawingReleasedAtRisk",
          eventPayload: { assemblyDrawingId: revision.assemblyDrawingId, revisionNo: revision.revisionNo },
        },
      };
    });
  });
}
