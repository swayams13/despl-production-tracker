import { withTenant, type Tx } from "@/lib/db";
import { assertNotClientUser, hasRole, requireRole, ROLES, type Actor } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { MasterDataStatus, PartMakeBuy } from "@/generated/prisma/client";
import { existingHe, heContent, heSignature, HE_FAMILY, HE_TEMPLATE_NAME } from "./master-import.he";
import { writeRouteVariant } from "./master-data.routes";
import { deriveDimensionKeys, type PartDecision, type VariantDecision } from "./master-import.rules";
import {
  buildReport,
  dbPartFamilySignature,
  partFamilySignature,
  prepareImport,
  type DryRunReport,
  type Outcome,
  type Tally,
} from "./master-import.service";

/**
 * Lean Core M2 (PR B) — applies the Standard Parts Master. ONE transaction,
 * idempotent: a second apply of the same workbook writes nothing.
 *
 *   - Only what the dry-run calls loadable is written; the rest is reported.
 *   - APPROVED parts get a PUBLISHED route version and are approved by the
 *     importing Production Head (server clock). Draft / Reviewed parts (staging,
 *     `allowDraft`) get DRAFT versions that materialisation ignores until M3
 *     approves them.
 *   - A PUBLISHED version is never edited (invariant 9): changed content makes
 *     a new version. A DRAFT version is replaced in place.
 *   - Standard times are always PROPOSED (D17); nothing here validates them.
 *   - The HE Stages sheet becomes a DRAFT HEAT_EXCHANGER template, never
 *     published here.
 *   - Every change writes its own audit row in the same transaction.
 */

export interface ApplyResult {
  /** The plan, computed before any write. */
  report: DryRunReport;
  written: {
    partFamilies: Tally;
    routes: Tally;
    stageMappingRows: number;
    materialGrades: Tally;
    heTemplate: Outcome;
  };
}

const zero = (): Tally => ({ create: 0, update: 0, unchanged: 0, skipped: 0 });

function toStatus(p: PartDecision): MasterDataStatus {
  return p.status as MasterDataStatus;
}

export async function applyWithDb(
  tx: Tx,
  actor: Actor,
  bytes: Buffer | Uint8Array,
  opts: { allowDraft: boolean },
): Promise<ApplyResult> {
  const tenantId = actor.tenantId;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`master-import:${tenantId}`}))`;

  const { wb, ev } = await prepareImport(tx, tenantId, bytes, opts);
  const structural = ev.issues.filter((i) => i.code === "SHEET_MISSING" || i.code === "COLUMN_MISSING");
  if (structural.length > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      reason: "the workbook is missing a sheet or column the importer needs",
      issues: structural.map((i) => i.message),
    });
  }
  if (ev.parts.some((p) => p.load && p.status === "APPROVED") && !hasRole(actor, ROLES.PRODUCTION_HEAD)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, { reason: "only the Production Head approves master data" });
  }
  const report = await buildReport(tx, tenantId, wb, ev, opts.allowDraft);

  const [operations, departments, types, families, clock] = await Promise.all([
    tx.operationRef.findMany({ where: { tenantId }, select: { id: true, code: true } }),
    tx.department.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    tx.componentTypeRef.findMany({ where: { tenantId }, select: { id: true, code: true, name: true } }),
    tx.productFamily.findMany({ where: { tenantId, code: { in: ["PRESSURE_VESSEL", HE_FAMILY] } }, select: { id: true, code: true } }),
    tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`,
  ]);
  const now = clock[0].now; // DB clock (invariant 1)
  const operationId = new Map(operations.map((o) => [o.code, o.id]));
  const departmentId = new Map(departments.map((d) => [d.name, d.id]));
  const typeByCode = new Map(types.map((t) => [t.code, t]));
  const familyId = new Map(families.map((f) => [f.code, f.id]));
  const pvFamilyId = familyId.get("PRESSURE_VESSEL");
  const heFamilyId = familyId.get(HE_FAMILY);

  const needsPv = ev.parts.some((p) => p.variants.some((v) => v.load && v.steps.some((s) => s.pvStage != null)));
  const needsHe = ev.parts.some((p) => p.variants.some((v) => v.load && v.steps.some((s) => s.heStage != null))) || ev.heLoadable;
  if (needsPv && pvFamilyId == null) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", code: "PRESSURE_VESSEL" });
  if (needsHe && heFamilyId == null) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", code: HE_FAMILY });

  const written: ApplyResult["written"] = {
    partFamilies: zero(),
    routes: zero(),
    stageMappingRows: 0,
    materialGrades: zero(),
    heTemplate: "skipped",
  };
  const audit = (action: string, entityType: string, entityId: string | number, before: unknown, after: unknown) =>
    recordAudit(tx, actor, { action, entityType, entityId, before, after });

  // ── Part families and their routes ──────────────────────────────────────
  for (const p of ev.parts) {
    if (!p.load) {
      written.partFamilies.skipped++;
      written.routes.skipped += p.variants.length;
      continue;
    }
    let type = typeByCode.get(p.code);
    if (!type) {
      type = await tx.componentTypeRef.create({
        data: { tenantId, code: p.code, name: p.name, kind: "PART_FAMILY" },
        select: { id: true, code: true, name: true },
      });
      typeByCode.set(type.code, type);
    } else if (type.name !== p.name) {
      await tx.componentTypeRef.update({ where: { id: type.id }, data: { name: p.name } });
    }

    const existing = await tx.partFamily.findUnique({
      where: { componentTypeId: type.id },
      include: { rawForm: { select: { code: true } } },
    });
    const rawFormId = p.rawFormCode ? (typeByCode.get(p.rawFormCode)?.id ?? null) : null;
    const status = toStatus(p);
    const wasApproved = existing?.status === "APPROVED";
    const data = {
      equipmentScope: p.scope!,
      assemblyGroup: p.assemblyGroup || null,
      makeBuy: p.makeBuy as PartMakeBuy | null,
      rawFormId,
      typicalMoc: p.typicalMoc || null,
      dimensionKeys: deriveDimensionKeys(p.dimensions),
      weightBasis: p.weightBasis || null,
      isSpare: p.isSpare,
      routeSource: p.routeSource || null,
      status,
      approvedById: status === "APPROVED" ? (wasApproved ? existing!.approvedById : actor.userId) : null,
      approvedAt: status === "APPROVED" ? (wasApproved ? existing!.approvedAt : now) : null,
    };
    if (!existing) {
      const created = await tx.partFamily.create({ data: { tenantId, componentTypeId: type.id, ...data } });
      await audit("masterImport.partFamily.create", "PartFamily", created.id, undefined, { code: p.code, name: p.name, status, dimensions: p.dimensions });
      written.partFamilies.create++;
    } else if (dbPartFamilySignature(type.name, existing) !== partFamilySignature(p)) {
      await tx.partFamily.update({ where: { id: existing.id }, data });
      await audit("masterImport.partFamily.update", "PartFamily", existing.id, { status: existing.status }, { code: p.code, name: p.name, status });
      written.partFamilies.update++;
    } else {
      written.partFamilies.unchanged++;
    }

    for (const v of p.variants) {
      if (!v.load) {
        written.routes.skipped++;
        continue;
      }
      await applyRoute(v, p, type.id, status);
    }
  }

  async function applyRoute(v: VariantDecision, p: PartDecision, typeId: number, status: MasterDataStatus) {
    const w = await writeRouteVariant(
      tx,
      { tenantId, operationId, departmentId, pvFamilyId, heFamilyId },
      { typeId, variant: v.variant, name: p.name, steps: v.steps, wantStatus: status === "APPROVED" ? "PUBLISHED" : "DRAFT" },
    );
    written.routes[w.outcome]++;
    written.stageMappingRows += w.mappingRows;
    if (w.action === "published") {
      await audit("masterImport.route.publish", "RouteTemplateVersion", w.versionId!, { status: w.previousStatus }, { status: "PUBLISHED", partCode: p.code, variant: v.variant });
    } else if (w.action !== "unchanged") {
      await audit(`masterImport.route.${w.outcome}`, "RouteTemplateVersion", w.versionId!, undefined, {
        partCode: p.code,
        variant: v.variant,
        version: w.version,
        status: w.status,
        steps: v.steps.length,
        stageMappings: w.mappingRows,
      });
    }
  }

  // ── Material grades ─────────────────────────────────────────────────────
  for (const m of ev.materials) {
    if (!m.load) {
      written.materialGrades.skipped++;
      continue;
    }
    const where = { tenantId_spec_grade_productForm: { tenantId, spec: m.spec, grade: m.grade, productForm: m.productForm } };
    const have = await tx.materialGrade.findUnique({ where });
    const density = m.densityGcc;
    if (!have) {
      const row = await tx.materialGrade.create({
        data: { tenantId, spec: m.spec, grade: m.grade, productForm: m.productForm, densityGcc: density, remarks: m.remarks || null },
      });
      await audit("masterImport.materialGrade.create", "MaterialGrade", row.id, undefined, { spec: m.spec, grade: m.grade, productForm: m.productForm, densityGcc: density });
      written.materialGrades.create++;
    } else if ((have.densityGcc == null ? null : Number(have.densityGcc.toString())) !== density) {
      await tx.materialGrade.update({ where: { id: have.id }, data: { densityGcc: density } });
      await audit("masterImport.materialGrade.update", "MaterialGrade", have.id, { densityGcc: have.densityGcc?.toString() ?? null }, { densityGcc: density });
      written.materialGrades.update++;
    } else {
      written.materialGrades.unchanged++;
    }
  }

  // ── HE template (always DRAFT) ──────────────────────────────────────────
  if (ev.heLoadable) {
    const content = heContent(ev.heStages);
    const have = await existingHe(tx, tenantId);
    if (have && have.signature === heSignature(content)) {
      written.heTemplate = "unchanged";
    } else {
      let versionId: number;
      let outcome: "create" | "update";
      if (!have) {
        const template = await tx.processTemplate.create({
          data: { tenantId, familyId: heFamilyId!, name: HE_TEMPLATE_NAME },
          select: { id: true },
        });
        versionId = (
          await tx.processTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "DRAFT" }, select: { id: true } })
        ).id;
        outcome = "create";
      } else if (have.status === "DRAFT") {
        await tx.templateEdge.deleteMany({ where: { versionId: have.versionId } });
        await tx.templateProcess.deleteMany({ where: { versionId: have.versionId } });
        versionId = have.versionId;
        outcome = "update";
      } else {
        versionId = (
          await tx.processTemplateVersion.create({
            data: { templateId: have.templateId, version: have.version + 1, status: "DRAFT" },
            select: { id: true },
          })
        ).id;
        outcome = "update";
      }
      const idByCode = new Map<string, number>();
      for (const proc of content.processes) {
        const row = await tx.templateProcess.create({
          data: {
            versionId,
            seq: proc.seq,
            code: proc.code,
            name: proc.name,
            mainActivities: proc.mainActivities,
            defaultDepartmentId: departmentId.get(proc.department)!,
            durationMinDays: proc.durationMinDays,
            durationMaxDays: proc.durationMaxDays,
            workOrderStages: [],
            optional: proc.optional,
            provisional: true, // planning estimates, per the workbook's own remarks
          },
          select: { id: true },
        });
        idByCode.set(proc.code, row.id);
      }
      for (const e of content.edges) {
        await tx.templateEdge.create({
          data: {
            versionId,
            processId: idByCode.get(e.process)!,
            predecessorId: idByCode.get(e.predecessor)!,
            type: e.type as "FINISH_TO_START" | "START_TO_START_WITH_OVERLAP",
            lagDays: e.lagDays,
          },
        });
      }
      await audit(`masterImport.heTemplate.${outcome}`, "ProcessTemplateVersion", versionId, undefined, {
        processes: content.processes.length,
        edges: content.edges.length,
        status: "DRAFT",
      });
      written.heTemplate = outcome;
    }
  }

  const changed =
    written.partFamilies.create + written.partFamilies.update + written.routes.create + written.routes.update +
    written.materialGrades.create + written.materialGrades.update + (written.heTemplate === "create" || written.heTemplate === "update" ? 1 : 0);
  if (changed > 0) {
    await audit("masterImport.apply", "MasterImport", `${tenantId}:${now.toISOString()}`, undefined, {
      allowDraft: opts.allowDraft,
      partFamilies: written.partFamilies,
      routes: written.routes,
      stageMappingRows: written.stageMappingRows,
      materialGrades: written.materialGrades,
      heTemplate: written.heTemplate,
      issues: report.issueSummary,
    });
  }
  return { report, written };
}

/** App entry point: Production Head or Admin; approving needs the Production Head. */
export async function applyMasterImport(
  actor: Actor,
  bytes: Buffer | Uint8Array,
  opts: { allowDraft?: boolean } = {},
): Promise<ApplyResult> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);
  return withTenant(actor.tenantId, (tx) => applyWithDb(tx, actor, bytes, { allowDraft: opts.allowDraft ?? false }), {
    timeoutMs: 120_000,
  });
}
