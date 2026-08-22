import { withTenant } from "@/lib/db";
import { assertNotClientUser, ROLES, requireRole, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * Everything the intake wizard's dropdowns need, in one round trip.
 *
 * `schedulable` on a family is the honest signal the wizard renders: a family
 * with no PUBLISHED template version cannot take a job at all, and the UI must
 * say so and offer the fix rather than showing a dead option.
 */

export interface IntakeFamily {
  id: number;
  code: string;
  name: string;
  /** At least one PUBLISHED template version exists. */
  schedulable: boolean;
  versions: Array<{
    id: number;
    templateName: string;
    version: number;
    processCount: number;
    /** Processes with no confirmed duration — this route will not produce dates. */
    provisionalCount: number;
    notes: string | null;
  }>;
}

export interface IntakeOptions {
  clients: Array<{ id: number; name: string; code: string | null }>;
  families: IntakeFamily[];
  calendars: Array<{ id: number; name: string; isDefault: boolean }>;
  equipmentTypes: Array<{
    id: number;
    familyId: number;
    code: string;
    name: string;
    defaultDesignCode: string | null;
    defaultSpecs: Record<string, unknown> | null;
  }>;
  qcpTemplates: Array<{ id: number; label: string; vessel: string; revision: number; itemCount: number }>;
  bomSources: Array<{ equipmentId: number; label: string; itemCount: number }>;
}

export async function loadIntakeOptions(actor: Actor): Promise<IntakeOptions> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const [clients, families, calendars, equipmentTypes, qcpTemplates, equipments] = await Promise.all([
      tx.client.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, code: true },
      }),
      tx.productFamily.findMany({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { name: "asc" },
        include: {
          templates: {
            include: {
              versions: {
                where: { status: "PUBLISHED" },
                orderBy: { version: "desc" },
                include: { processes: { select: { provisional: true, durationMinDays: true, durationMaxDays: true } } },
              },
            },
          },
        },
      }),
      tx.workCalendar.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        select: { id: true, name: true, isDefault: true },
      }),
      tx.equipmentTypeRef.findMany({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { name: "asc" },
        select: {
          id: true,
          familyId: true,
          code: true,
          name: true,
          defaultDesignCode: true,
          defaultSpecs: true,
        },
      }),
      tx.qcpTemplate.findMany({
        where: { OR: [{ job: { tenantId: actor.tenantId } }, { jobId: null }] },
        orderBy: { jobLabel: "asc" },
        include: { _count: { select: { items: true } } },
      }),
      tx.equipment.findMany({
        where: { job: { tenantId: actor.tenantId }, bomItems: { some: {} } },
        include: { job: { select: { jobNumber: true } }, _count: { select: { bomItems: true } } },
        orderBy: { id: "asc" },
      }),
    ]);

    return {
      clients,
      families: families.map((f) => {
        const versions = f.templates.flatMap((t) =>
          t.versions.map((v) => ({
            id: v.id,
            templateName: t.name,
            version: v.version,
            processCount: v.processes.length,
            provisionalCount: v.processes.filter(
              (p) => p.provisional || p.durationMinDays == null || p.durationMaxDays == null,
            ).length,
            notes: v.notes,
          })),
        );
        return {
          id: f.id,
          code: f.code,
          name: f.name,
          schedulable: versions.length > 0,
          versions,
        };
      }),
      calendars,
      equipmentTypes: equipmentTypes.map((e) => ({
        ...e,
        defaultSpecs: (e.defaultSpecs as Record<string, unknown> | null) ?? null,
      })),
      qcpTemplates: qcpTemplates.map((q) => ({
        id: q.id,
        label: q.jobLabel,
        vessel: q.vessel,
        revision: q.revision,
        itemCount: q._count.items,
      })),
      bomSources: equipments.map((e) => ({
        equipmentId: e.id,
        label: `${e.job.jobNumber} — ${e.name}`,
        itemCount: e._count.bomItems,
      })),
    };
  });
}

export interface EquipmentTypeAdminRow {
  id: number;
  familyId: number;
  familyName: string;
  code: string;
  name: string;
  defaultDesignCode: string | null;
  defaultSpecs: Record<string, unknown> | null;
  active: boolean;
}

/**
 * Every equipment type — active and inactive, with its family name — for the
 * `/admin/equipment-types` catalog screen. Deliberately NOT
 * `loadIntakeOptions().equipmentTypes`: that list is active-only and scoped
 * to exactly what the wizard's dropdown needs, which is wrong here — this
 * screen must show (and let an admin reactivate) inactive rows too.
 */
export async function loadEquipmentTypeAdmin(actor: Actor): Promise<EquipmentTypeAdminRow[]> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.equipmentTypeRef.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: [{ family: { name: "asc" } }, { name: "asc" }],
      include: { family: { select: { name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      familyId: r.familyId,
      familyName: r.family.name,
      code: r.code,
      name: r.name,
      defaultDesignCode: r.defaultDesignCode,
      defaultSpecs: (r.defaultSpecs as Record<string, unknown> | null) ?? null,
      active: r.active,
    }));
  });
}

/** The process list for step 2's include/exclude checkboxes. */
export async function loadTemplateProcesses(
  actor: Actor,
  versionId: number,
): Promise<
  Array<{
    code: string;
    seq: number;
    name: string;
    departmentName: string;
    optional: boolean;
    provisional: boolean;
    durationMaxDays: number | null;
  }>
> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const version = await tx.processTemplateVersion.findFirst({
      where: { id: versionId, template: { tenantId: actor.tenantId } },
      select: { id: true },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", versionId });
    }
    const processes = await tx.templateProcess.findMany({
      where: { versionId },
      orderBy: { seq: "asc" },
      include: { defaultDepartment: { select: { name: true } } },
    });
    return processes.map((p) => ({
      code: p.code,
      seq: p.seq,
      name: p.name,
      departmentName: p.defaultDepartment.name,
      optional: p.optional,
      provisional: p.provisional,
      durationMaxDays: p.durationMaxDays,
    }));
  });
}
