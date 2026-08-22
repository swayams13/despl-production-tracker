import { withTenant } from "@/lib/db";
import { assertNotClientUser, ROLES, requireRole, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * Read models for the route-authoring screens. Dates are serialised to ISO
 * strings at the boundary so these can cross the RSC → client component line
 * without a Date instance in the payload, matching admin.read.ts.
 */

export interface TemplateVersionRow {
  id: number;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  publishedAt: string | null;
  publishedByName: string | null;
  notes: string | null;
  processCount: number;
  /** Jobs pinned to this version — what tells an admin whether it is load-bearing. */
  jobCount: number;
}

export interface TemplateRow {
  id: number;
  name: string;
  versions: TemplateVersionRow[];
}

export interface FamilyRow {
  id: number;
  code: string;
  name: string;
  templates: TemplateRow[];
}

export async function loadTemplateIndex(actor: Actor): Promise<FamilyRow[]> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const families = await tx.productFamily.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { name: "asc" },
      include: {
        templates: {
          orderBy: { name: "asc" },
          include: {
            versions: {
              orderBy: { version: "desc" },
              include: {
                _count: { select: { processes: true, jobs: true } },
              },
            },
          },
        },
      },
    });

    const publisherIds = [
      ...new Set(
        families.flatMap((f) =>
          f.templates.flatMap((t) => t.versions.map((v) => v.publishedBy).filter((x): x is number => x != null)),
        ),
      ),
    ];
    const publishers = publisherIds.length
      ? await tx.user.findMany({ where: { id: { in: publisherIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(publishers.map((u) => [u.id, u.name]));

    return families.map((f) => ({
      id: f.id,
      code: f.code,
      name: f.name,
      templates: f.templates.map((t) => ({
        id: t.id,
        name: t.name,
        versions: t.versions.map((v) => ({
          id: v.id,
          version: v.version,
          status: v.status as "DRAFT" | "PUBLISHED",
          publishedAt: v.publishedAt?.toISOString() ?? null,
          publishedByName: v.publishedBy != null ? (nameById.get(v.publishedBy) ?? null) : null,
          notes: v.notes,
          processCount: v._count.processes,
          jobCount: v._count.jobs,
        })),
      })),
    }));
  });
}

export interface VersionEditorProcess {
  id: number;
  seq: number;
  code: string;
  name: string;
  mainActivities: string | null;
  defaultDepartmentId: number;
  departmentName: string;
  durationMinDays: number | null;
  durationMaxDays: number | null;
  envelopeStartByMinDays: number | null;
  envelopeStartByMaxDays: number | null;
  envelopeFinishByMinDays: number | null;
  envelopeFinishByMaxDays: number | null;
  workOrderStages: number[];
  optional: boolean;
  provisional: boolean;
}

export interface VersionEditorEdge {
  processId: number;
  predecessorId: number;
  type: "FINISH_TO_START" | "START_TO_START_WITH_OVERLAP";
  lagDays: number;
}

export interface VersionEditorView {
  versionId: number;
  templateId: number;
  templateName: string;
  familyName: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  notes: string | null;
  /** DRAFT only — invariant #9. The service refuses regardless of this flag. */
  editable: boolean;
  /** Optimistic-lock token the editor must send back on save. */
  updatedAt: string | null;
  /** Set when a later version of the same template exists, for the read-only banner. */
  supersededByVersion: number | null;
  processes: VersionEditorProcess[];
  edges: VersionEditorEdge[];
  departments: Array<{ id: number; name: string }>;
}

export async function loadVersionEditor(actor: Actor, versionId: number): Promise<VersionEditorView> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const version = await tx.processTemplateVersion.findFirst({
      where: { id: versionId, template: { tenantId: actor.tenantId } },
      include: {
        template: { include: { family: true } },
        processes: { orderBy: { seq: "asc" }, include: { defaultDepartment: true } },
        edges: true,
      },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", versionId });
    }

    const later = await tx.processTemplateVersion.findFirst({
      where: { templateId: version.templateId, version: { gt: version.version } },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    const departments = await tx.department.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });

    return {
      versionId: version.id,
      templateId: version.templateId,
      templateName: version.template.name,
      familyName: version.template.family.name,
      version: version.version,
      status: version.status as "DRAFT" | "PUBLISHED",
      notes: version.notes,
      editable: version.status === "DRAFT",
      updatedAt: version.updatedAt?.toISOString() ?? null,
      supersededByVersion: later?.version ?? null,
      processes: version.processes.map((p) => ({
        id: p.id,
        seq: p.seq,
        code: p.code,
        name: p.name,
        mainActivities: p.mainActivities,
        defaultDepartmentId: p.defaultDepartmentId,
        departmentName: p.defaultDepartment.name,
        durationMinDays: p.durationMinDays,
        durationMaxDays: p.durationMaxDays,
        envelopeStartByMinDays: p.envelopeStartByMinDays,
        envelopeStartByMaxDays: p.envelopeStartByMaxDays,
        envelopeFinishByMinDays: p.envelopeFinishByMinDays,
        envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
        workOrderStages: p.workOrderStages,
        optional: p.optional,
        provisional: p.provisional,
      })),
      edges: version.edges.map((e) => ({
        processId: e.processId,
        predecessorId: e.predecessorId,
        type: e.type as VersionEditorEdge["type"],
        lagDays: e.lagDays,
      })),
      departments,
    };
  });
}
