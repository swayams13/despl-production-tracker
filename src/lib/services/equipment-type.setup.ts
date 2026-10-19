// Lean Core J1: idempotent setup of the pressure-vessel equipment types, the
// "vertical on skirt" assembly template (a copy of the family template's
// published version) and its component kit. One implementation for prisma/seed.ts
// and scripts/lean-backfill-equipment-types.ts. Relative imports only: both run
// under tsx outside the Next.js path aliases and RLS context (owner role).
import type { Prisma } from "../../generated/prisma/client";
import { PV_EQUIPMENT_TYPES, PV_SKIRT_KIT } from "../shared/equipment-type";

type Db = Prisma.TransactionClient;

export const SKIRT_TYPE_CODE = PV_EQUIPMENT_TYPES[0].code;

export interface EquipmentTypeSetupReport {
  typesCreated: string[];
  templateCreated: string | null;
  templateSteps: number;
  kitCreated: string[];
  /** Why something was not created (missing family template, unknown component type, ...). */
  skipped: string[];
  skirtTypeId: number | null;
}

/**
 * Reads always; writes only when `apply`. A second run creates nothing. Rows
 * that already exist are never edited (invariant 9: published templates are
 * immutable), so a type someone changed in the admin screen stays as it is.
 */
export async function ensurePvEquipmentTypes(
  db: Db,
  tenantId: number,
  opts: { apply: boolean; audit?: boolean; auditSource?: string },
): Promise<EquipmentTypeSetupReport> {
  const report: EquipmentTypeSetupReport = {
    typesCreated: [],
    templateCreated: null,
    templateSteps: 0,
    kitCreated: [],
    skipped: [],
    skirtTypeId: null,
  };
  const auditRows: Prisma.AuditLogCreateManyInput[] = [];
  const audit = (action: string, entityType: string, entityId: number, after: unknown) =>
    auditRows.push({
      tenantId,
      actorId: null,
      action,
      entityType,
      entityId: String(entityId),
      after: after as never,
      userAgent: opts.auditSource ?? "equipment-type.setup",
    });

  const family = await db.productFamily.findFirst({ where: { tenantId, code: "PRESSURE_VESSEL" } });
  if (!family) {
    report.skipped.push("family PRESSURE_VESSEL not found");
    return report;
  }

  // 1. The three proposed types (decision D18 is open).
  const typeIdByCode = new Map<string, number>();
  for (const t of PV_EQUIPMENT_TYPES) {
    const existing = await db.equipmentTypeRef.findFirst({ where: { tenantId, code: t.code } });
    if (existing) {
      typeIdByCode.set(t.code, existing.id);
      continue;
    }
    report.typesCreated.push(t.code);
    if (!opts.apply) continue;
    const row = await db.equipmentTypeRef.create({
      data: { tenantId, familyId: family.id, code: t.code, name: t.name, active: t.active },
    });
    typeIdByCode.set(t.code, row.id);
    audit("setup.equipmentType.create", "EquipmentTypeRef", row.id, { code: t.code, active: t.active });
  }
  const skirtTypeId = typeIdByCode.get(SKIRT_TYPE_CODE) ?? null;
  report.skirtTypeId = skirtTypeId;

  // 2. The skirt template: a copy of the family template's latest published version.
  const owned = skirtTypeId != null ? await db.assemblyTemplate.findFirst({ where: { equipmentTypeId: skirtTypeId } }) : null;
  if (!owned) {
    const source = await db.assemblyTemplate.findFirst({
      where: { tenantId, familyId: family.id, equipmentTypeId: null },
      orderBy: { id: "asc" },
    });
    const version = source
      ? await db.assemblyTemplateVersion.findFirst({
          where: { templateId: source.id, status: "PUBLISHED", steps: { some: {} } },
          orderBy: { version: "desc" },
          include: { steps: { orderBy: { seq: "asc" } } },
        })
      : null;
    if (!source || !version) {
      report.skipped.push("no published family assembly template to copy for the skirt type");
    } else {
      report.templateCreated = `${source.name} (vertical on skirt)`;
      report.templateSteps = version.steps.length;
      if (opts.apply && skirtTypeId != null) {
        const template = await db.assemblyTemplate.create({
          data: { tenantId, familyId: family.id, name: report.templateCreated, equipmentTypeId: skirtTypeId },
        });
        const copy = await db.assemblyTemplateVersion.create({
          data: {
            templateId: template.id,
            version: 1,
            status: "PUBLISHED",
            publishedAt: new Date(),
            notes: `J1: copy of "${source.name}" v${version.version}`,
          },
        });
        await db.assemblyTemplateStep.createMany({
          data: version.steps.map(({ id: _id, versionId: _versionId, ...step }) => ({ ...step, versionId: copy.id })),
        });
        audit("setup.assemblyTemplate.create", "AssemblyTemplate", template.id, {
          equipmentTypeId: skirtTypeId,
          copiedFromVersionId: version.id,
          steps: version.steps.length,
        });
      }
    }
  }

  // 3. The skirt kit: DESPL-320's components per unit, FIXED.
  if (skirtTypeId != null) {
    const have = await db.equipmentTypeComponent.findMany({
      where: { equipmentTypeId: skirtTypeId },
      select: { componentType: { select: { code: true } } },
    });
    const haveCodes = new Set(have.map((h) => h.componentType.code));
    for (const k of PV_SKIRT_KIT) {
      if (haveCodes.has(k.componentTypeCode)) continue;
      const ct = await db.componentTypeRef.findFirst({ where: { tenantId, code: k.componentTypeCode } });
      if (!ct) {
        report.skipped.push(`component type ${k.componentTypeCode} not found`);
        continue;
      }
      report.kitCreated.push(k.componentTypeCode);
      if (!opts.apply) continue;
      const row = await db.equipmentTypeComponent.create({
        data: { tenantId, equipmentTypeId: skirtTypeId, componentTypeId: ct.id, defaultQty: k.defaultQty, qtySource: "FIXED" },
      });
      audit("setup.equipmentTypeComponent.create", "EquipmentTypeComponent", row.id, {
        component: k.componentTypeCode,
        defaultQty: k.defaultQty,
      });
    }
  } else if (!opts.apply) {
    report.kitCreated.push(...PV_SKIRT_KIT.map((k) => k.componentTypeCode));
  }

  if (opts.apply && opts.audit && auditRows.length > 0) await db.auditLog.createMany({ data: auditRows });
  return report;
}
