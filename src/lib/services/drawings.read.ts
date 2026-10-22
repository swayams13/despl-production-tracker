import { withTenant } from "@/lib/db";
import { assertClientScope, assertNotClientUser, hasRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { drawingStateOf, type DrawingState } from "@/lib/shared/floor-rules";
import { DRAWING_WRITE_ROLES } from "./drawing.service";
import { activeRow } from "./active-row";

/**
 * Lean Core JG1: the job's drawing register for /jobs/[id]/drawings. Which
 * drawings exist, where each stands for H3 (released, at risk, not released),
 * and the pressure parts that no drawing governs yet, which H3 cannot gate.
 */

export interface DrawingRevisionRow {
  id: number;
  revisionNo: number;
  status: string;
  releasedAt: Date | null;
  atRisk: { reason: string; by: string | null; at: Date; clientConsentRef: string | null } | null;
}
export interface DrawingRegisterRow {
  id: number;
  drawingNo: string;
  typeName: string;
  remarks: string | null;
  /** H3 state of the current (highest) revision; NOT_RELEASED when none is issued. */
  state: DrawingState;
  /** Highest revision, or null while none is issued. */
  current: DrawingRevisionRow | null;
  /** What "Issue revision" proposes: highest + 1, or 0 for the first. */
  nextRevisionNo: number;
  revisions: DrawingRevisionRow[];
  linkedParts: number;
}
export interface UnlinkedPart {
  id: number;
  tag: string;
  serialNo: string | null;
  lineId: number;
  lineName: string;
}
export interface DrawingsView {
  job: { id: number; jobNumber: string; projectName: string | null };
  drawings: DrawingRegisterRow[];
  drawingTypes: Array<{ id: number; name: string }>;
  lines: Array<{ id: number; name: string }>;
  unlinked: UnlinkedPart[];
  /** Create, issue a revision, link. */
  canWrite: boolean;
  /** Production Head only. */
  canReleaseAtRisk: boolean;
}

export async function loadJobDrawings(actor: Actor, jobId: number): Promise<DrawingsView> {
  assertNotClientUser(actor);
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      select: { id: true, jobNumber: true, projectName: true, clientId: true },
    });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });
    assertClientScope(actor, job.clientId);

    const [drawings, types, equipment, parts] = await Promise.all([
      tx.assemblyDrawing.findMany({
        where: { jobId },
        orderBy: { id: "asc" },
        include: {
          drawingType: { select: { name: true } },
          revisions: { orderBy: { revisionNo: "desc" }, include: { atRiskReleasedBy: { select: { name: true } } } },
          _count: { select: { governingComponents: true } },
        },
      }),
      tx.drawingTypeRef.findMany({ where: { tenantId: actor.tenantId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
      tx.equipment.findMany({ where: { jobId }, orderBy: { id: "asc" }, select: { id: true, name: true } }),
      tx.component.findMany({
        where: { ...activeRow, jobId, tenantId: actor.tenantId, pressureRetaining: true, governingDrawingId: null },
        orderBy: [{ equipmentId: "asc" }, { id: "asc" }],
        select: { id: true, tag: true, equipmentId: true, unit: { select: { serialNo: true } } },
      }),
    ]);

    const lineName = new Map(equipment.map((e) => [e.id, e.name]));
    return {
      job: { id: job.id, jobNumber: job.jobNumber, projectName: job.projectName },
      drawings: drawings.map((d) => {
        const revisions: DrawingRevisionRow[] = d.revisions.map((r) => ({
          id: r.id,
          revisionNo: r.revisionNo,
          status: r.status,
          releasedAt: r.releasedAt,
          atRisk: r.atRiskReleasedAt
            ? { reason: r.atRiskReason ?? "", by: r.atRiskReleasedBy?.name ?? null, at: r.atRiskReleasedAt, clientConsentRef: r.clientConsentRef }
            : null,
        }));
        const top = d.revisions[0];
        return {
          id: d.id,
          drawingNo: d.drawingNo ?? `Drawing ${d.id}`,
          typeName: d.drawingType.name,
          remarks: d.remarks,
          state: drawingStateOf(top ? { status: top.status, atRiskReleasedAt: top.atRiskReleasedAt } : null),
          current: revisions[0] ?? null,
          nextRevisionNo: top ? top.revisionNo + 1 : 0,
          revisions,
          linkedParts: d._count.governingComponents,
        };
      }),
      drawingTypes: types,
      lines: equipment,
      unlinked: parts.map((p) => ({ id: p.id, tag: p.tag, serialNo: p.unit?.serialNo ?? null, lineId: p.equipmentId, lineName: lineName.get(p.equipmentId) ?? "" })),
      canWrite: hasRole(actor, ...DRAWING_WRITE_ROLES),
      canReleaseAtRisk: hasRole(actor, ROLES.PRODUCTION_HEAD),
    };
  });
}
