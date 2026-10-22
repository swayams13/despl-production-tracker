import { withJob } from "@/lib/db";
import { assertNotClientUser, hasRole, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { BOM_RELEASE_ROLES, BOM_REVIEW_ROLES } from "@/lib/shared/stores-access";
import type { OperationStatus } from "@/generated/prisma/client";
import { activeRow } from "./active-row";

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
/** J5c: a started floor row a BOM re-release changed, waiting for Keep / Replace / Cancel. */
export interface ReviewRow {
  kind: "ASSEMBLY_STEP" | "COMPONENT_OP";
  id: number;
  unit: string;
  label: string;
  status: OperationStatus;
  /** The BOM revision that flagged it (null when the audit trail has no record). */
  sinceRevisionNo: number | null;
  /** What changed, in words. */
  what: string[];
}
export interface ReleaseLine {
  id: number;
  name: string;
  units: number;
  revisions: ReleaseRevision[];
  /** J5c: rows waiting for review on this line (shown to the roles that can resolve them). */
  review: ReviewRow[];
  /** J5c: the line's current (newest materialised) revision number. */
  currentRevisionNo: number | null;
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
  /** J5c: may Keep / Replace / Cancel the rows waiting for review. */
  canReview: boolean;
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
      // j5c: any row, retired or not, means this line has floor rows
      tx.assemblyStep.findMany({ where: { jobId }, distinct: ["unitId"], select: { unit: { select: { equipmentId: true } } } }),
      tx.componentTypeRef.findMany({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { code: "asc" },
        select: { id: true, code: true, name: true, kind: true, partFamily: { select: { status: true } } },
      }),
    ]);
    const stepLines = new Set(stepped.map((s) => s.unit.equipmentId));
    const canReview = hasRole(actor, ...BOM_REVIEW_ROLES);
    const review = canReview ? await loadReview(tx, actor.tenantId, jobId, job.equipments.map((e) => ({ id: e.id, revisions: e.bomRevisions }))) : new Map<number, ReviewRow[]>();
    const looseOf = new Map(loose.map((l) => [l.equipmentId, l._count]));
    return {
      job: { id: job.id, jobNumber: job.jobNumber, projectName: job.projectName },
      canRelease: hasRole(actor, ...BOM_RELEASE_ROLES),
      canReview,
      lines: job.equipments.map((e) => ({
        id: e.id,
        name: e.name,
        units: e._count.units,
        revisions: e.bomRevisions.map((r) => ({ id: r.id, revisionNo: r.revisionNo, status: r.status, materializedAt: r.materializedAt, items: r._count.bomItems })),
        review: review.get(e.id) ?? [],
        currentRevisionNo: e.bomRevisions.filter((r) => r.materializedAt != null).reduce<number | null>((m, r) => (m == null || r.revisionNo > m ? r.revisionNo : m), null),
        looseItems: looseOf.get(e.id) ?? 0,
        legacy: (e._count.components > 0 || stepLines.has(e.id)) && !e.bomRevisions.some((r) => r.materializedAt != null),
      })),
      families: types
        .filter((t) => t.kind === "RAW_FORM" || t.partFamily != null)
        .map((t) => ({ id: t.id, code: t.code, name: t.name, approved: t.kind === "RAW_FORM" || t.partFamily?.status === "APPROVED" })),
    };
  });
}

type Db = Parameters<Parameters<typeof withJob>[2]>[0];
const FIELD_WORDS: Record<string, (f: { from: unknown; to: unknown }) => string> = {
  quantity: (f) => `quantity ${f.from ?? "none"} \u2192 ${f.to ?? "none"}`,
  partName: (f) => `name "${f.from}" \u2192 "${f.to}"`,
  partFamily: () => "part family changed",
  routeVariant: (f) => `route variant ${f.from ?? "default"} \u2192 ${f.to ?? "default"}`,
  joint: (f) => `joint ${f.from ?? "none"} \u2192 ${f.to ?? "none"}`,
  line: () => "the BOM line was removed or has no part family",
  step: () => "no longer in the route or sequence",
  part: () => "now belongs to another part",
};
const wordsOf = (f: { field: string; from: unknown; to: unknown }) => (FIELD_WORDS[f.field] ?? (() => `${f.field} changed`))(f);

/** Rows waiting for review per line, with the revision that flagged them and what changed (from the release audit rows). */
async function loadReview(
  tx: Db,
  tenantId: number,
  jobId: number,
  lines: { id: number; revisions: { id: number; revisionNo: number; materializedAt: Date | null }[] }[],
): Promise<Map<number, ReviewRow[]>> {
  const [steps, ops] = await Promise.all([
    tx.assemblyStep.findMany({
      where: { ...activeRow, jobId, needsReview: true },
      orderBy: [{ unitId: "asc" }, { seq: "asc" }],
      select: { id: true, status: true, jointRef: true, unit: { select: { serialNo: true, equipmentId: true } }, templateStep: { select: { activity: true } } },
    }),
    tx.componentOperation.findMany({
      where: { ...activeRow, jobId, needsReview: true },
      orderBy: [{ componentId: "asc" }, { seq: "asc" }],
      select: { id: true, status: true, operation: { select: { name: true } }, component: { select: { tag: true, equipmentId: true, unit: { select: { serialNo: true } } } } },
    }),
  ]);
  const out = new Map<number, ReviewRow[]>();
  if (steps.length + ops.length === 0) return out;
  const revisionNoOf = new Map(lines.flatMap((l) => l.revisions.map((r) => [String(r.id), r.revisionNo] as const)));
  const audits = await tx.auditLog.findMany({
    where: { tenantId, action: "bom.release", entityType: "BomRevision", entityId: { in: [...revisionNoOf.keys()] } },
    orderBy: { id: "desc" },
    select: { entityId: true, after: true },
  });
  const seen = new Map<string, { revisionNo: number | null; what: string[] }>();
  for (const a of audits) {
    const rows = ((a.after as { diff?: { rows?: { entity: string; id: number | null; class: string; fields: { field: string; from: unknown; to: unknown }[] }[] } } | null)?.diff?.rows) ?? [];
    for (const r of rows) {
      if (r.class !== "review" || r.id == null) continue;
      const key = `${r.entity === "step" ? "ASSEMBLY_STEP" : "COMPONENT_OP"}:${r.id}`;
      if (!seen.has(key)) seen.set(key, { revisionNo: revisionNoOf.get(a.entityId) ?? null, what: r.fields.map(wordsOf) });
    }
  }
  const push = (equipmentId: number, row: ReviewRow) => out.set(equipmentId, [...(out.get(equipmentId) ?? []), row]);
  for (const s of steps) {
    const hit = seen.get(`ASSEMBLY_STEP:${s.id}`);
    push(s.unit.equipmentId, { kind: "ASSEMBLY_STEP", id: s.id, unit: s.unit.serialNo, label: `${s.templateStep.activity}${s.jointRef ? ` \u00b7 ${s.jointRef}` : ""}`, status: s.status, sinceRevisionNo: hit?.revisionNo ?? null, what: hit?.what ?? [] });
  }
  for (const o of ops) {
    const hit = seen.get(`COMPONENT_OP:${o.id}`);
    push(o.component.equipmentId, { kind: "COMPONENT_OP", id: o.id, unit: o.component.unit?.serialNo ?? "All units", label: `${o.component.tag} \u00b7 ${o.operation.name}`, status: o.status, sinceRevisionNo: hit?.revisionNo ?? null, what: hit?.what ?? [] });
  }
  return out;
}
