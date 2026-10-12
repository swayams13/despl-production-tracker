import { withTenant } from "@/lib/db";
import { assertNotClientUser, hasRole, requireRole, ROLES, type Actor } from "@/lib/authz";
import { loadHeStageMap } from "./master-import.he";
import { loadReferenceData } from "./master-import.service";
import type { NormalStep, Scope } from "./master-import.rules";
import { evaluateReadiness, type Readiness } from "./master-data.readiness";
import { loadVariantsFor, type VariantRow } from "./master-data.routes";
import { MASTER_DATA_EDIT_ROLES, MASTER_DATA_READ_ROLES } from "./master-data.service";

/**
 * Lean Core M3 — read models for the Master data screens. Read-only and
 * tenant-scoped. Readiness comes from the same rules approval uses.
 */
export type MasterStatus = "DRAFT" | "REVIEWED" | "APPROVED";

export interface PartFamilyListRow {
  id: number;
  code: string;
  name: string;
  scope: Scope;
  status: MasterStatus;
  assemblyGroup: string | null;
  makeBuy: string | null;
  rawForm: string | null;
  isSpare: boolean;
  variants: string[];
  steps: number;
  /** Variants that are DRAFT (waiting for approval). */
  draftVariants: number;
  blockers: number;
  warnings: number;
  approvedAt: string | null;
}

export interface PartFamilyFilters {
  q?: string;
  scope?: Scope;
  status?: MasterStatus;
  group?: string;
  hasBlockers?: boolean;
}

export interface PartFamilyList {
  rows: PartFamilyListRow[];
  groups: string[];
  totals: { all: number; draft: number; reviewed: number; approved: number; withBlockers: number };
  canEdit: boolean;
}

function guardRead(actor: Actor): void {
  assertNotClientUser(actor);
  requireRole(actor, ...MASTER_DATA_READ_ROLES);
}

async function familyIds(tx: Parameters<Parameters<typeof withTenant>[1]>[0], tenantId: number) {
  const f = await tx.productFamily.findMany({ where: { tenantId, code: { in: ["PRESSURE_VESSEL", "HEAT_EXCHANGER"] } }, select: { id: true, code: true } });
  return {
    pvFamilyId: f.find((x) => x.code === "PRESSURE_VESSEL")?.id,
    heFamilyId: f.find((x) => x.code === "HEAT_EXCHANGER")?.id,
  };
}

export async function loadPartFamilies(actor: Actor, filters: PartFamilyFilters = {}): Promise<PartFamilyList> {
  guardRead(actor);
  return withTenant(actor.tenantId, async (tx) => {
    const [parts, ref, heStages, families] = await Promise.all([
      tx.partFamily.findMany({
        where: { tenantId: actor.tenantId },
        include: { componentType: { select: { code: true, name: true } }, rawForm: { select: { name: true } } },
        orderBy: { componentType: { code: "asc" } },
      }),
      loadReferenceData(tx, actor.tenantId),
      loadHeStageMap(tx, actor.tenantId),
      familyIds(tx, actor.tenantId),
    ]);
    const variantsByType = await loadVariantsFor(tx, actor.tenantId, parts.map((p) => p.componentTypeId), families);

    const all: PartFamilyListRow[] = parts.map((p) => {
      const variants = variantsByType.get(p.componentTypeId) ?? [];
      const readiness = evaluateReadiness(
        { code: p.componentType.code, scope: p.equipmentScope as Scope, routeSource: p.routeSource },
        variants,
        ref,
        heStages,
      );
      return {
        id: p.id,
        code: p.componentType.code,
        name: p.componentType.name,
        scope: p.equipmentScope as Scope,
        status: p.status as MasterStatus,
        assemblyGroup: p.assemblyGroup,
        makeBuy: p.makeBuy,
        rawForm: p.rawForm?.name ?? null,
        isSpare: p.isSpare,
        variants: variants.map((v) => v.variant),
        steps: variants.reduce((n, v) => n + v.steps.length, 0),
        draftVariants: variants.filter((v) => v.status === "DRAFT").length,
        blockers: readiness.blockers.length,
        warnings: readiness.warnings.length,
        approvedAt: p.approvedAt?.toISOString() ?? null,
      };
    });

    const q = filters.q?.trim().toLowerCase();
    const rows = all.filter(
      (r) =>
        (!q || r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) &&
        (!filters.scope || r.scope === filters.scope) &&
        (!filters.status || r.status === filters.status) &&
        (!filters.group || r.assemblyGroup === filters.group) &&
        (!filters.hasBlockers || r.blockers > 0),
    );
    return {
      rows,
      groups: [...new Set(all.map((r) => r.assemblyGroup).filter((g): g is string => !!g))].sort(),
      totals: {
        all: all.length,
        draft: all.filter((r) => r.status === "DRAFT").length,
        reviewed: all.filter((r) => r.status === "REVIEWED").length,
        approved: all.filter((r) => r.status === "APPROVED").length,
        withBlockers: all.filter((r) => r.blockers > 0).length,
      },
      canEdit: hasRole(actor, ...MASTER_DATA_EDIT_ROLES),
    };
  });
}

export interface PartFamilyDetail {
  id: number;
  code: string;
  name: string;
  scope: Scope;
  status: MasterStatus;
  assemblyGroup: string | null;
  makeBuy: string | null;
  rawForm: string | null;
  typicalMoc: string | null;
  weightBasis: string | null;
  dimensionKeys: string[];
  isSpare: boolean;
  routeSource: string | null;
  remarks: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  preparedBy: string | null;
  variants: Array<Omit<VariantRow, "steps"> & { steps: Array<Omit<NormalStep, "row">> }>;
  readiness: Readiness;
  /** What this actor may do with this part right now. */
  can: { edit: boolean; review: boolean; approve: boolean; revise: boolean };
  /** Why approve is unavailable to this actor, in words, when it is. */
  approveRefusal: string | null;
  reference: {
    operations: Array<{ code: string; name: string }>;
    departments: string[];
    pvStages: Array<{ no: number; name: string; department: string | null }>;
    heStages: Array<{ no: number; department: string }>;
  };
}

export async function loadPartFamily(actor: Actor, partFamilyId: number): Promise<PartFamilyDetail | null> {
  guardRead(actor);
  return withTenant(actor.tenantId, async (tx) => {
    const p = await tx.partFamily.findFirst({
      where: { id: partFamilyId, tenantId: actor.tenantId },
      include: {
        componentType: { select: { code: true, name: true } },
        rawForm: { select: { name: true } },
        approvedBy: { select: { name: true } },
        preparedBy: { select: { name: true } },
      },
    });
    if (!p) return null;
    const [ref, heStages, families, operations] = await Promise.all([
      loadReferenceData(tx, actor.tenantId),
      loadHeStageMap(tx, actor.tenantId),
      familyIds(tx, actor.tenantId),
      tx.operationRef.findMany({ where: { tenantId: actor.tenantId, active: true }, orderBy: { name: "asc" }, select: { code: true, name: true } }),
    ]);
    const variants = (await loadVariantsFor(tx, actor.tenantId, [p.componentTypeId], families)).get(p.componentTypeId) ?? [];
    const readiness = evaluateReadiness(
      { code: p.componentType.code, scope: p.equipmentScope as Scope, routeSource: p.routeSource },
      variants,
      ref,
      heStages,
    );
    const isHead = hasRole(actor, ROLES.PRODUCTION_HEAD);
    const editor = hasRole(actor, ...MASTER_DATA_EDIT_ROLES);
    const status = p.status as MasterStatus;
    let approveRefusal: string | null = null;
    if (status === "APPROVED") approveRefusal = "Already approved.";
    else if (!isHead) approveRefusal = "Only the Production Head approves master data.";
    else if (p.preparedById != null && p.preparedById === actor.userId) approveRefusal = "You prepared this part, so someone else must approve it.";
    else if (readiness.blockers.length > 0) approveRefusal = `${readiness.blockers.length} thing${readiness.blockers.length === 1 ? "" : "s"} to fix first.`;

    const dimensionKeys = Array.isArray(p.dimensionKeys) ? (p.dimensionKeys as unknown[]).filter((x): x is string => typeof x === "string") : [];
    return {
      id: p.id,
      code: p.componentType.code,
      name: p.componentType.name,
      scope: p.equipmentScope as Scope,
      status,
      assemblyGroup: p.assemblyGroup,
      makeBuy: p.makeBuy,
      rawForm: p.rawForm?.name ?? null,
      typicalMoc: p.typicalMoc,
      weightBasis: p.weightBasis,
      dimensionKeys,
      isSpare: p.isSpare,
      routeSource: p.routeSource,
      remarks: p.remarks,
      approvedAt: p.approvedAt?.toISOString() ?? null,
      approvedBy: p.approvedBy?.name ?? null,
      preparedBy: p.preparedBy?.name ?? null,
      variants: variants.map((v) => ({ ...v, steps: v.steps.map(({ row: _row, ...s }) => s) })),
      readiness,
      can: {
        edit: editor && status !== "APPROVED",
        review: editor && status === "DRAFT",
        approve: approveRefusal === null,
        revise: editor && status === "APPROVED",
      },
      approveRefusal,
      reference: {
        operations,
        departments: [...ref.departmentNames].sort(),
        pvStages: [...ref.pvStages].map(([no, v]) => ({ no, ...v })).sort((a, b) => a.no - b.no),
        heStages: [...heStages].map(([no, v]) => ({ no, ...v })).sort((a, b) => a.no - b.no),
      },
    };
  });
}

export interface MaterialGradeRow {
  id: number;
  spec: string;
  grade: string;
  productForm: string;
  densityGcc: number | null;
  remarks: string | null;
  status: MasterStatus;
}

export async function loadMaterialGrades(actor: Actor): Promise<{ rows: MaterialGradeRow[]; canEdit: boolean; canApprove: boolean }> {
  guardRead(actor);
  return withTenant(actor.tenantId, async (tx) => {
    const grades = await tx.materialGrade.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: [{ spec: "asc" }, { grade: "asc" }, { productForm: "asc" }],
    });
    return {
      rows: grades.map((g) => ({
        id: g.id,
        spec: g.spec,
        grade: g.grade,
        productForm: g.productForm,
        densityGcc: g.densityGcc == null ? null : Number(g.densityGcc.toString()),
        remarks: g.remarks,
        status: g.status as MasterStatus,
      })),
      canEdit: hasRole(actor, ...MASTER_DATA_EDIT_ROLES),
      canApprove: hasRole(actor, ROLES.PRODUCTION_HEAD),
    };
  });
}
