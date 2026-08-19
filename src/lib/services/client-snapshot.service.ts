import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import {
  publishSnapshotSchema,
  verifySnapshotSchema,
  rejectSnapshotSchema,
  type PublishSnapshotInput,
  type VerifySnapshotInput,
  type RejectSnapshotInput,
} from "@/lib/shared/schemas";
import { notify, userIdsWithRole } from "./notifications.service";
import { loadJobSpines, type UnitSpine } from "./spine.read";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { ProgressSnapshot } from "@/generated/prisma/client";

interface BatchResult {
  jobId: number;
  asOf: Date;
  unitCount: number;
}

// Noon UTC, not midnight — IST is UTC+5:30, so noon UTC always renders as the
// correct IST calendar day, matching this app's "store UTC, display IST" convention.
/** Today, stamped server-side at noon UTC — never a caller-supplied date (invariant #1). */
function todayAsOf(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
}

/** A unit's current stage: the first non-complete segment, or the last one if every segment is complete. */
function currentStage(spine: UnitSpine): { stageNo: number; stageName: string; status: StageDisplayStatus } {
  const active = spine.segments.find((s) => s.status !== "complete");
  const segment = active ?? spine.segments[spine.segments.length - 1];
  return { stageNo: segment.stageNo, stageName: segment.stageName, status: segment.status };
}

/** A unit's % complete: completed segments over the full 25-stage spine. */
function unitPercentComplete(spine: UnitSpine): number {
  const done = spine.segments.filter((s) => s.status === "complete").length;
  return Math.round((done / spine.segments.length) * 100);
}

async function loadTodayBatch(tx: Tx, jobId: number, asOf: Date): Promise<ProgressSnapshot[]> {
  return tx.progressSnapshot.findMany({ where: { jobId, asOf } });
}

export async function publishSnapshot(actor: Actor, input: PublishSnapshotInput): Promise<BatchResult> {
  const { jobId } = publishSnapshotSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);

  const asOf = todayAsOf();

  // Its own withTenant transaction (loadJobSpines) — never nested inside
  // another, matching notifications.service.ts's syncHoldPointAgedNotifications.
  const spines = await loadJobSpines(actor, jobId);
  if (!spines || spines.length === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { jobId, reason: "job has no units to publish" });
  }

  return withTenant(actor.tenantId, async (tx) => {
    // At most one PUBLISHED asOf per job at a time (write-time invariant) —
    // an earlier day's batch left un-reviewed must be verified or rejected
    // before a new one can be published, otherwise verify/rejectSnapshot's
    // `pending[0]` would pick an arbitrary batch across two undistinguished
    // PUBLISHED days.
    const priorDayPublished = await tx.progressSnapshot.findFirst({
      where: { jobId, status: "PUBLISHED", asOf: { not: asOf } },
    });
    if (priorDayPublished) {
      throw new AppError(ERROR_CODES.SNAPSHOT_PRIOR_DAY_PENDING, { jobId });
    }

    const existing = await loadTodayBatch(tx, jobId, asOf);
    if (existing.some((r) => r.status === "VERIFIED")) {
      throw new AppError(ERROR_CODES.SNAPSHOT_ALREADY_VERIFIED, { jobId, asOf });
    }

    return audited(tx, actor, async () => {
      const before = existing.map((r) => ({
        id: r.id,
        status: r.status,
        overallPct: r.overallPct,
        detail: r.detail,
        rejectionReason: r.rejectionReason,
      }));
      for (const spine of spines) {
        const stage = currentStage(spine);
        const percentComplete = unitPercentComplete(spine);
        await tx.progressSnapshot.upsert({
          where: { jobId_unitId_asOf: { jobId, unitId: spine.unitId, asOf } },
          create: {
            tenantId: actor.tenantId,
            jobId,
            unitId: spine.unitId,
            asOf,
            overallPct: percentComplete,
            detail: { stageNo: stage.stageNo, stageName: stage.stageName, status: stage.status, serialNo: spine.serialNo },
            status: "PUBLISHED",
            publishedBy: actor.userId,
            publishedAt: new Date(),
            verifiedBy: null,
            verifiedAt: null,
            rejectionReason: null,
          },
          update: {
            overallPct: percentComplete,
            detail: { stageNo: stage.stageNo, stageName: stage.stageName, status: stage.status, serialNo: spine.serialNo },
            status: "PUBLISHED",
            publishedBy: actor.userId,
            publishedAt: new Date(),
            rejectionReason: null,
          },
        });
      }

      const managementIds = await userIdsWithRole(tx, actor.tenantId, "MANAGEMENT");
      await notify(
        tx,
        actor.tenantId,
        managementIds.map((recipientId) => ({
          recipientId,
          type: "CLIENT_UPDATE_PUBLISHED",
          entityType: "Job",
          entityId: jobId,
          title: "Client update ready for review",
          body: `Published by ${actor.name}`,
          payload: { jobId },
        })),
      );

      return {
        result: { jobId, asOf, unitCount: spines.length },
        audit: {
          action: "clientSnapshot.publish",
          entityType: "ProgressSnapshotBatch",
          entityId: `${jobId}:${asOf.toISOString()}`,
          before,
          after: { jobId, asOf, unitCount: spines.length, status: "PUBLISHED" },
          eventType: "ClientSnapshotPublished",
          eventPayload: { jobId, asOf: asOf.toISOString(), unitCount: spines.length, publishedBy: actor.userId },
        },
      };
    });
  });
}

export async function verifySnapshot(actor: Actor, input: VerifySnapshotInput): Promise<BatchResult> {
  const { jobId } = verifySnapshotSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.MANAGEMENT, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const pending = await tx.progressSnapshot.findMany({ where: { jobId, status: "PUBLISHED" }, orderBy: { asOf: "asc" } });
    if (pending.length === 0) throw new AppError(ERROR_CODES.SNAPSHOT_NOT_PUBLISHED, { jobId });

    if (pending.some((r) => r.publishedBy === actor.userId)) {
      throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { publishedBy: actor.userId });
    }

    const publishedBy = pending[0].publishedBy;
    const asOf = pending[0].asOf;

    return audited(tx, actor, async () => {
      await tx.progressSnapshot.updateMany({
        where: { jobId, asOf, status: "PUBLISHED" },
        data: { status: "VERIFIED", verifiedBy: actor.userId, verifiedAt: new Date() },
      });

      return {
        result: { jobId, asOf, unitCount: pending.length },
        audit: {
          action: "clientSnapshot.verify",
          entityType: "ProgressSnapshotBatch",
          entityId: `${jobId}:${asOf.toISOString()}`,
          before: { status: "PUBLISHED", publishedBy },
          after: { status: "VERIFIED", verifiedBy: actor.userId },
          eventType: "ClientSnapshotVerified",
          eventPayload: { jobId, asOf: asOf.toISOString(), unitCount: pending.length, verifiedBy: actor.userId },
        },
      };
    });
  });
}

export async function rejectSnapshot(actor: Actor, input: RejectSnapshotInput): Promise<BatchResult> {
  const { jobId, reason } = rejectSnapshotSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.MANAGEMENT, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const pending = await tx.progressSnapshot.findMany({ where: { jobId, status: "PUBLISHED" }, orderBy: { asOf: "asc" } });
    if (pending.length === 0) throw new AppError(ERROR_CODES.SNAPSHOT_NOT_PUBLISHED, { jobId });

    if (pending.some((r) => r.publishedBy === actor.userId)) {
      throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { publishedBy: actor.userId });
    }

    const publishedBy = pending[0].publishedBy;
    const asOf = pending[0].asOf;

    const result = await audited(tx, actor, async () => {
      await tx.progressSnapshot.updateMany({
        where: { jobId, asOf, status: "PUBLISHED" },
        data: { status: "REJECTED", rejectionReason: reason },
      });

      return {
        result: { jobId, asOf, unitCount: pending.length },
        audit: {
          action: "clientSnapshot.reject",
          entityType: "ProgressSnapshotBatch",
          entityId: `${jobId}:${asOf.toISOString()}`,
          before: { status: "PUBLISHED", publishedBy },
          after: { status: "REJECTED", reason },
          eventType: "ClientSnapshotRejected",
          eventPayload: { jobId, asOf: asOf.toISOString(), unitCount: pending.length, rejectedBy: actor.userId, reason },
        },
      };
    });

    if (publishedBy != null) {
      await notify(tx, actor.tenantId, [
        {
          recipientId: publishedBy,
          type: "CLIENT_UPDATE_REJECTED",
          entityType: "Job",
          entityId: jobId,
          title: "Client update rejected",
          body: `${reason} · ${actor.name}`,
          payload: { jobId },
        },
      ]);
    }

    return result;
  });
}
