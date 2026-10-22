import { withJob } from "@/lib/db";
import { assertNotClientUser, hasRole, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { BOM_RELEASE_ROLES } from "@/lib/shared/stores-access";

/**
 * J5b: what the BOM release screen needs before a preview: the job's lines, each line's BOM
 * revisions, and the part families a BOM line can be mapped to. Readable by every internal role;
 * `canRelease` says whether the viewer may preview, map and release.
 */

export interface ReleaseRevision {
  id: number;
  revisionNo: number;
  status: "DRAFT" | "RELEASED";
  materializedAt: Date | null;
  items: number;
}
export interface ReleaseLine {
  id: number;
  name: string;
  units: number;
  revisions: ReleaseRevision[];
  /** BOM lines on this line that are in no revision (they are not released until moved into one). */
  looseItems: number;
  /** The line already has components or assembly steps from before the BOM release existed. */
  legacy: boolean;
}
export interface ReleaseFamilyOption {
  id: number;
  code: string;
  name: string;
  approved: boolean;
}
export interface BomReleaseView {
  job: { id: number; jobNumber: string; projectName: string | null };
  canRelease: boolean;
  lines: ReleaseLine[];
  families: ReleaseFamilyOption[];
}

export async function loadBomReleaseView(actor: Actor, jobId: number): Promise<BomReleaseView> {
  assertNotClientUser(actor);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });
  return withJob(actor.tenantId, jobId, async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      select: {
        id: true,
        jobNumber: true,
        projectName: true,
        equipments: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            name: true,
            _count: { select: { units: true, components: true } },
            bomRevisions: { orderBy: { revisionNo: "asc" }, select: { id: true, revisionNo: true, status: true, materializedAt: true, _count: { select: { bomItems: true } } } },
          },
        },
      },
    });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });
    const equipmentIds = job.equipments.map((e) => e.id);
    const [loose, stepped, types] = await Promise.all([
      tx.bomItem.groupBy({ by: ["equipmentId"], where: { jobId, equipmentId: { in: equipmentIds }, bomRevisionId: null }, _count: true }),
      tx.assemblyStep.findMany({ where: { jobId }, distinct: ["unitId"], select: { unit: { select: { equipmentId: true } } } }),
      tx.componentTypeRef.findMany({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { code: "asc" },
        select: { id: true, code: true, name: true, kind: true, partFamily: { select: { status: true } } },
      }),
    ]);
    const stepLines = new Set(stepped.map((s) => s.unit.equipmentId));
    const looseOf = new Map(loose.map((l) => [l.equipmentId, l._count]));
    return {
      job: { id: job.id, jobNumber: job.jobNumber, projectName: job.projectName },
      canRelease: hasRole(actor, ...BOM_RELEASE_ROLES),
      lines: job.equipments.map((e) => ({
        id: e.id,
        name: e.name,
        units: e._count.units,
        revisions: e.bomRevisions.map((r) => ({ id: r.id, revisionNo: r.revisionNo, status: r.status, materializedAt: r.materializedAt, items: r._count.bomItems })),
        looseItems: looseOf.get(e.id) ?? 0,
        legacy: (e._count.components > 0 || stepLines.has(e.id)) && !e.bomRevisions.some((r) => r.materializedAt != null),
      })),
      families: types
        .filter((t) => t.kind === "RAW_FORM" || t.partFamily != null)
        .map((t) => ({ id: t.id, code: t.code, name: t.name, approved: t.kind === "RAW_FORM" || t.partFamily?.status === "APPROVED" })),
    };
  });
}
