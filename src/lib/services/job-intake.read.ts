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

export interface ProductFamilyAdminRow {
  id: number;
  code: string;
  name: string;
  active: boolean;
  jobCount: number;
}

/** C1: the plain family list — readiness (has a published route/QCP) is C8, not here. */
export async function loadProductFamilyAdmin(actor: Actor): Promise<ProductFamilyAdminRow[]> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.productFamily.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { name: "asc" },
      include: { _count: { select: { jobs: true } } },
    });
    return rows.map((f) => ({
      id: f.id,
      code: f.code,
      name: f.name,
      active: f.active,
      jobCount: f._count.jobs,
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

// ── Component route authoring (C6) ──────────────────────────────────────

export interface RouteStepAdminRow {
  seq: number;
  operationCode: string;
  operationName: string;
  printed: string | null;
  optional: boolean;
}

export interface RouteTemplateVersionAdminRow {
  id: number;
  version: number;
  status: string;
  printedRoute: string | null;
  stepCount: number;
  steps: RouteStepAdminRow[];
  /** Component rows pinned to this exact version (`Component.routeVersionId`). */
  jobCount: number;
}

export interface RouteTemplateAdminRow {
  id: number;
  name: string;
  versions: RouteTemplateVersionAdminRow[];
}

export interface ComponentTypeRouteAdminRow {
  componentTypeId: number;
  componentTypeCode: string;
  componentTypeName: string;
  /** The familyId: null route for this component type, if one exists. */
  shared: RouteTemplateAdminRow | null;
  /** Family-specific routes, which take precedence over `shared` at intake time. */
  families: Array<{ familyId: number; familyName: string; route: RouteTemplateAdminRow }>;
}

export interface OperationRefFamilySeqAdminRow {
  operationRefId: number;
  operationCode: string;
  operationName: string;
  mappings: Array<{ familyId: number; familyName: string; leadTimeProcessSeq: number }>;
}

export interface RouteTemplateAdmin {
  componentTypes: ComponentTypeRouteAdminRow[];
  /** Every OperationRef used by any route in this tenant, with its per-family lead-time-seq mappings. */
  operationFamilySeqs: OperationRefFamilySeqAdminRow[];
  /** Every ProductFamily — for the family picker in the author/revise dialog. */
  families: Array<{ id: number; name: string }>;
  /** The full OperationRef catalog — for the step editor's "existing operation" picker. */
  operations: Array<{ id: number; code: string; name: string; defaultDepartmentId: number | null }>;
  departments: Array<{ id: number; name: string }>;
}

/**
 * Everything the route-authoring admin screen needs in one round trip: every
 * `ComponentTypeRef`'s routes (shared + per-family), each version's steps,
 * every referenced `OperationRef`'s current `OperationRefFamilySeq` mappings
 * (so the UI can show e.g. "CUTTING → PRESSURE_VESSEL: seq 12, PIPE_SPOOL:
 * (not set)"), and the plain option lists (families, the full operation
 * catalog, departments) the author/revise dialog needs for its pickers.
 */
export async function loadRouteTemplateAdmin(actor: Actor): Promise<RouteTemplateAdmin> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const [componentTypes, families, operations, departments] = await Promise.all([
      tx.componentTypeRef.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: { name: "asc" },
      }),
      tx.productFamily.findMany({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      tx.operationRef.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: { name: "asc" },
        select: { id: true, code: true, name: true, defaultDepartmentId: true },
      }),
      tx.department.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
    ]);

    const routes = await tx.routeTemplate.findMany({
      where: { tenantId: actor.tenantId },
      include: {
        family: { select: { id: true, name: true } },
        versions: {
          orderBy: { version: "desc" },
          include: {
            steps: { orderBy: { seq: "asc" }, include: { operation: { select: { code: true, name: true } } } },
            _count: { select: { components: true } },
          },
        },
      },
    });

    const routesByComponentType = new Map<number, typeof routes>();
    for (const r of routes) {
      const list = routesByComponentType.get(r.componentTypeId) ?? [];
      list.push(r);
      routesByComponentType.set(r.componentTypeId, list);
    }

    const toRouteRow = (r: (typeof routes)[number]): RouteTemplateAdminRow => ({
      id: r.id,
      name: r.name,
      versions: r.versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        printedRoute: v.printedRoute,
        stepCount: v.steps.length,
        steps: v.steps.map((s) => ({
          seq: s.seq,
          operationCode: s.operation.code,
          operationName: s.operation.name,
          printed: s.printed,
          optional: s.optional,
        })),
        jobCount: v._count.components,
      })),
    });

    const componentTypeRows: ComponentTypeRouteAdminRow[] = componentTypes.map((ct) => {
      const forType = routesByComponentType.get(ct.id) ?? [];
      const shared = forType.find((r) => r.familyId == null);
      const familyRoutes = forType
        .filter((r) => r.familyId != null)
        .map((r) => ({ familyId: r.familyId!, familyName: r.family!.name, route: toRouteRow(r) }));
      return {
        componentTypeId: ct.id,
        componentTypeCode: ct.code,
        componentTypeName: ct.name,
        shared: shared ? toRouteRow(shared) : null,
        families: familyRoutes,
      };
    });

    const operationRefIds = [
      ...new Set(routes.flatMap((r) => r.versions.flatMap((v) => v.steps.map((s) => s.operationId)))),
    ];
    const usedOperations =
      operationRefIds.length === 0
        ? []
        : await tx.operationRef.findMany({
            where: { id: { in: operationRefIds } },
            include: { familySeqMappings: { include: { family: { select: { id: true, name: true } } } } },
          });

    const operationFamilySeqs: OperationRefFamilySeqAdminRow[] = usedOperations.map((o) => ({
      operationRefId: o.id,
      operationCode: o.code,
      operationName: o.name,
      mappings: o.familySeqMappings.map((m) => ({
        familyId: m.familyId,
        familyName: m.family.name,
        leadTimeProcessSeq: m.leadTimeProcessSeq,
      })),
    }));

    return { componentTypes: componentTypeRows, operationFamilySeqs, families, operations, departments };
  });
}

// ── QCP template authoring (C7) ──────────────────────────────────────────

export interface QcpTemplateItemAdminRow {
  id: number;
  sequence: number;
  srNo: string;
  kind: string;
  section: string | null;
  activity: string;
  characteristic: string | null;
  extentOfCheck: string | null;
  applicableDocument: string | null;
  acceptanceCriteria: string | null;
  record: string | null;
  remarks: string | null;
  /** For a library item: the process codes it will resolve to once cloned. */
  libraryProcessCodes: string[];
  partyCodes: Array<{ partyCode: string; qcpCode: string; blocksCompletion: boolean; waivable: boolean }>;
}

export interface QcpTemplateLibraryAdminRow {
  id: number;
  jobLabel: string;
  vessel: string;
  revision: number;
  designCode: string | null;
  parties: Array<{ id: number; code: string; name: string | null }>;
  items: QcpTemplateItemAdminRow[];
}

/**
 * Every library `QcpTemplate` (jobId null) with its parties and items, for
 * the from-scratch authoring admin screen (list + detail). Same missing-
 * tenant-anchor caveat as `cloneQcpTemplate`/`loadIntakeOptions` — a
 * library row genuinely has no tenantId column to scope by.
 */
export async function loadQcpTemplateLibraryAdmin(actor: Actor): Promise<QcpTemplateLibraryAdminRow[]> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const templates = await tx.qcpTemplate.findMany({
      where: { jobId: null },
      orderBy: { jobLabel: "asc" },
      include: {
        parties: { orderBy: { code: "asc" } },
        items: {
          orderBy: { sequence: "asc" },
          include: { partyCodes: { include: { inspectionParty: true, qcpCode: true } } },
        },
      },
    });

    return templates.map((t) => ({
      id: t.id,
      jobLabel: t.jobLabel,
      vessel: t.vessel,
      revision: t.revision,
      designCode: t.designCode,
      parties: t.parties.map((p) => ({ id: p.id, code: p.code, name: p.name })),
      items: t.items.map((i) => ({
        id: i.id,
        sequence: i.sequence,
        srNo: i.srNo,
        kind: i.kind,
        section: i.section,
        activity: i.activity,
        characteristic: i.characteristic,
        extentOfCheck: i.extentOfCheck,
        applicableDocument: i.applicableDocument,
        acceptanceCriteria: i.acceptanceCriteria,
        record: i.record,
        remarks: i.remarks,
        libraryProcessCodes: i.libraryProcessCodes,
        partyCodes: i.partyCodes.map((pc) => ({
          partyCode: pc.inspectionParty.code,
          qcpCode: pc.qcpCode.code,
          blocksCompletion: pc.qcpCode.blocksCompletion,
          waivable: pc.qcpCode.waivable,
        })),
      })),
    }));
  });
}

export interface QcpCodeRefOption {
  code: string;
  label: string;
  blocksCompletion: boolean;
  waivable: boolean;
}

/** The tenant's QcpCodeRef catalog, for the party-code picker in the C7
 * item-authoring form — `addQcpItemToLibraryTemplate` refuses any `qcpCode`
 * not already in this list. */
export async function loadQcpCodeRefOptions(actor: Actor): Promise<QcpCodeRefOption[]> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.qcpCodeRef.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { code: "asc" },
    });
    return rows.map((r) => ({ code: r.code, label: r.label, blocksCompletion: r.blocksCompletion, waivable: r.waivable }));
  });
}
