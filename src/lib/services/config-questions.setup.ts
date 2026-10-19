// Lean Core J2: idempotent setup of the pressure-vessel config questions and
// the one-off rename of legacy camelCase default specs on equipment types.
// Shared by prisma/seed.ts and scripts/lean-backfill-config-questions.ts
// (relative imports only; runs as the table owner, outside RLS).
import type { Prisma } from "../../generated/prisma/client";
import { LEGACY_SPEC_KEYS, PV_CONFIG_QUESTIONS } from "../shared/pv-config-questions";

type Db = Prisma.TransactionClient;

export interface ConfigQuestionSetupReport {
  created: string[];
  /** Equipment types whose defaultSpecs keys were renamed (code, before, after). */
  renamed: { code: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  skipped: string[];
}

export async function ensurePvConfigQuestions(
  db: Db,
  tenantId: number,
  opts: { apply: boolean; audit?: boolean; auditSource?: string },
): Promise<ConfigQuestionSetupReport> {
  const report: ConfigQuestionSetupReport = { created: [], renamed: [], skipped: [] };
  const family = await db.productFamily.findFirst({ where: { tenantId, code: "PRESSURE_VESSEL" } });
  if (!family) {
    report.skipped.push("family PRESSURE_VESSEL not found");
    return report;
  }
  const audit: Prisma.AuditLogCreateManyInput[] = [];
  const log = (action: string, entityType: string, entityId: number, before: unknown, after: unknown) =>
    audit.push({
      tenantId,
      actorId: null,
      action,
      entityType,
      entityId: String(entityId),
      before: before as never,
      after: after as never,
      userAgent: opts.auditSource ?? "config-questions.setup",
    });

  const have = new Set(
    (await db.configQuestion.findMany({ where: { familyId: family.id }, select: { key: true } })).map((q) => q.key),
  );
  for (const [i, q] of PV_CONFIG_QUESTIONS.entries()) {
    if (have.has(q.key)) continue;
    report.created.push(q.key);
    if (!opts.apply) continue;
    const row = await db.configQuestion.create({
      data: {
        tenantId,
        familyId: family.id,
        key: q.key,
        label: q.label,
        type: q.type,
        unit: q.unit ?? null,
        options: q.options ? (q.options as never) : undefined,
        sortOrder: (i + 1) * 10,
      },
    });
    log("setup.configQuestion.create", "ConfigQuestion", row.id, null, { key: q.key, type: q.type });
  }

  // Legacy camelCase keys on the family's equipment types become snake_case. Unknown keys stay as they are.
  const types = await db.equipmentTypeRef.findMany({
    where: { tenantId, familyId: family.id },
    select: { id: true, code: true, defaultSpecs: true },
  });
  for (const t of types) {
    const before = (t.defaultSpecs ?? null) as Record<string, unknown> | null;
    if (!before || typeof before !== "object") continue;
    const after = Object.fromEntries(Object.entries(before).map(([k, v]) => [LEGACY_SPEC_KEYS[k] ?? k, v]));
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    report.renamed.push({ code: t.code, before, after });
    if (!opts.apply) continue;
    await db.equipmentTypeRef.update({ where: { id: t.id }, data: { defaultSpecs: after as never } });
    log("setup.equipmentType.renameSpecKeys", "EquipmentTypeRef", t.id, before, after);
  }

  if (opts.apply && opts.audit && audit.length > 0) await db.auditLog.createMany({ data: audit });
  return report;
}
