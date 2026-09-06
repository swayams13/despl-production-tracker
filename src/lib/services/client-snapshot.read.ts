import { withTenant } from "@/lib/db";
import { requireRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { ProgressSnapshot, ProgressSnapshotStatus } from "@/generated/prisma/client";

/** The only five values a client (or the internal preview) is ever shown. */
export type ClientStatus = "complete" | "progress" | "hold" | "overdue" | "idle";

interface SnapshotDetail {
  stageNo: number;
  stageName: string;
  status: StageDisplayStatus;
  serialNo: string;
}

export interface ClientUnitRow {
  serialNo: string;
  stageName: string;
  status: ClientStatus;
  percentComplete: number;
}

interface ClientJobViewBase {
  jobId: number;
  jobNumber: string;
  equipmentName: string | null;
}

export type ClientJobView =
  | (ClientJobViewBase & {
      hasUpdate: true;
      asOf: string | null;
      overallPct: number | null;
      forecastDispatch: string | null;
      units: ClientUnitRow[];
      unitsUnderInspection?: number;
    })
  | (ClientJobViewBase & { hasUpdate: false });

/**
 * Intersection, not a fresh interface — `ClientJobView & {...}` distributes
 * over the union, so `ClientPreview` is a proper structural subtype of
 * `ClientJobView` in both branches (`hasUpdate: true` gets real
 * asOf/overallPct/units; `hasUpdate: false` doesn't need them). This is
 * what makes `<ClientPortalView jobs={[preview]} />` (Task 7/9) typecheck
 * without a separate prop type — a `ClientPreview` IS a `ClientJobView`.
 */
export type ClientPreview = ClientJobView & {
  reviewStatus: "PUBLISHED" | "VERIFIED" | "REJECTED" | "NONE";
  rejectionReason: string | null;
  /** Internal-only — never present on plain `ClientJobView` reads, only on a preview. */
  publishedByName: string | null;
  /** The real verify event time (vs. `asOf`, always noon-UTC calendar marker) — for "Verified since" copy. */
  verifiedAt: string | null;
};

/**
 * The one place `submitted`/`hold` collapse to one client-facing value.
 * `submitted` is deliberately mapped to `hold` (not its own value) so the
 * UI always passes the same internal status to `<StatusChip>` for one
 * label — see spec §7/§8. Both parts of this file's public API go through
 * this function; nothing bypasses it.
 */
export function toClientStatus(internal: StageDisplayStatus): ClientStatus {
  if (internal === "submitted") return "hold";
  return internal;
}

/** Strips a stored `detail` blob down to exactly what a client may see. Pure. */
export function sanitizeDetail(detail: SnapshotDetail): { stageName: string; serialNo: string; status: ClientStatus } {
  return {
    stageName: detail.stageName,
    serialNo: detail.serialNo,
    status: toClientStatus(detail.status),
  };
}

function rowsToUnits(rows: ProgressSnapshot[]): ClientUnitRow[] {
  return rows
    .map((r) => {
      const detail = r.detail as unknown as SnapshotDetail | null;
      if (!detail) return null;
      const clean = sanitizeDetail(detail);
      return { serialNo: clean.serialNo, stageName: clean.stageName, status: clean.status, percentComplete: r.overallPct };
    })
    .filter((u): u is ClientUnitRow => u !== null)
    .sort((a, b) => a.serialNo.localeCompare(b.serialNo));
}

function overallFromUnits(units: ClientUnitRow[]): number {
  if (units.length === 0) return 0;
  return Math.round(units.reduce((sum, u) => sum + u.percentComplete, 0) / units.length);
}

/** Client-facing, client-scoped — every job the acting client owns. */
export async function loadClientPortalView(actor: Actor): Promise<ClientJobView[]> {
  if (actor.clientId === null) {
    throw new Error("loadClientPortalView is for client users only — use loadClientPreview internally");
  }

  return withTenant(actor.tenantId, async (tx) => {
    const jobs = await tx.job.findMany({
      where: { clientId: actor.clientId! },
      include: { equipments: { take: 1 } },
      orderBy: { jobNumber: "asc" },
    });

    // Per-client, not per-job — loaded once. A client with no policy row
    // defaults every toggle to true, matching the schema's own @default(true).
    const policy = await tx.clientVisibilityPolicy.findUnique({ where: { clientId: actor.clientId! } });
    const showProgress = policy?.showProgress ?? true;
    const showDates = policy?.showDates ?? true;
    const showQcp = policy?.showQcp ?? true;

    const jobIds = jobs.map((j) => j.id);
    const latestRows = jobIds.length
      ? await tx.$queryRaw<{ job_id: number; as_of: Date }[]>`
          SELECT DISTINCT ON (job_id) job_id, as_of
          FROM progress_snapshots
          WHERE job_id = ANY(${jobIds}::int[]) AND status = 'VERIFIED'
          ORDER BY job_id, as_of DESC
        `
      : [];
    const latestByJob = new Map(latestRows.map((r) => [r.job_id, r.as_of]));

    const allRows = jobIds.length
      ? await tx.progressSnapshot.findMany({
          where: {
            status: "VERIFIED",
            OR: latestRows.map((r) => ({ jobId: r.job_id, asOf: r.as_of })),
          },
        })
      : [];
    const rowsByJob = new Map<number, typeof allRows>();
    for (const r of allRows) {
      const bucket = rowsByJob.get(r.jobId);
      if (bucket) bucket.push(r);
      else rowsByJob.set(r.jobId, [r]);
    }

    const views: ClientJobView[] = [];
    for (const job of jobs) {
      const latestAsOf = latestByJob.get(job.id);
      const equipmentName = job.equipments[0]?.name ?? null;

      if (!latestAsOf) {
        views.push({ jobId: job.id, jobNumber: job.jobNumber, equipmentName, hasUpdate: false });
        continue;
      }

      const rows = rowsByJob.get(job.id) ?? [];
      const units = rowsToUnits(rows);
      views.push({
        jobId: job.id,
        jobNumber: job.jobNumber,
        equipmentName,
        hasUpdate: true,
        asOf: showDates ? latestAsOf.toISOString() : null,
        overallPct: showProgress ? overallFromUnits(units) : null,
        forecastDispatch: showDates ? (job.committedDeliveryDate?.toISOString() ?? null) : null,
        units,
        ...(showQcp ? { unitsUnderInspection: units.filter((u) => u.status === "hold").length } : {}),
      });
    }
    return views;
  });
}

/**
 * Internal preview — Production Head / Management / Admin only. Shows
 * whatever the real latest state is.
 *
 * // ponytail: always reads the single most recent day, no historical
 * // `asOf` browsing — the spec allows for it, but Task 9's UI never
 * // passes one. Add an optional `asOf?: Date` param + a where-clause
 * // branch when a "view a past day's release" screen actually exists.
 */
export async function loadClientPreview(actor: Actor, jobId: number): Promise<ClientPreview> {
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.MANAGEMENT, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: jobId },
      include: { equipments: { take: 1 } },
    });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { jobId });
    const equipmentName = job.equipments[0]?.name ?? null;

    const latest = await tx.progressSnapshot.findFirst({
      where: { jobId },
      orderBy: { asOf: "desc" },
      select: { asOf: true, status: true, publishedBy: true, rejectionReason: true, verifiedAt: true },
    });

    if (!latest) {
      return {
        jobId,
        jobNumber: job.jobNumber,
        equipmentName,
        hasUpdate: false,
        reviewStatus: "NONE",
        rejectionReason: null,
        publishedByName: null,
        verifiedAt: null,
      };
    }

    const rows = await tx.progressSnapshot.findMany({ where: { jobId, asOf: latest.asOf } });
    const units = rowsToUnits(rows);
    const publisher = latest.publishedBy ? await tx.user.findUnique({ where: { id: latest.publishedBy }, select: { name: true } }) : null;

    return {
      jobId,
      jobNumber: job.jobNumber,
      equipmentName,
      hasUpdate: true,
      asOf: latest.asOf.toISOString(),
      overallPct: overallFromUnits(units),
      forecastDispatch: job.committedDeliveryDate?.toISOString() ?? null,
      units,
      reviewStatus: latest.status as ProgressSnapshotStatus,
      rejectionReason: latest.rejectionReason,
      // publishedByName surfaced here only, never on a plain ClientJobView
      // read — an internal reviewer needs to know who to ask; a client never does.
      publishedByName: publisher?.name ?? null,
      verifiedAt: latest.verifiedAt?.toISOString() ?? null,
    };
  });
}
