// Lean Core J8 (D9): idempotent setup of the company milestones and the
// provisional pressure-vessel process -> milestone map. Used by
// scripts/lean-seed-milestones.ts and the tests (relative imports only; runs as
// the table owner, outside RLS). Never overwrites a row that exists: once SJ and
// the MD ratify or edit the map, a re-run leaves their version alone.
import type { Prisma } from "../../generated/prisma/client";
import { D9_MILESTONES, PV_MILESTONE_MAP } from "../shared/milestones";

type Db = Prisma.TransactionClient;

export interface MilestoneSetupReport {
  milestonesCreated: string[];
  mapsCreated: { family: string; count: number }[];
  skipped: string[];
}

export async function ensureMilestones(
  db: Db,
  tenantId: number,
  opts: {
    apply: boolean;
    auditSource?: string;
    /** family code -> (process code -> milestone code). Default: the provisional PV map. */
    maps?: Record<string, Record<string, string>>;
    milestones?: readonly { code: string; name: string }[];
  },
): Promise<MilestoneSetupReport> {
  const report: MilestoneSetupReport = { milestonesCreated: [], mapsCreated: [], skipped: [] };
  const audit: Prisma.AuditLogCreateManyInput[] = [];
  const log = (action: string, entityType: string, entityId: number, after: unknown) =>
    audit.push({
      tenantId,
      actorId: null,
      action,
      entityType,
      entityId: String(entityId),
      before: undefined,
      after: after as never,
      userAgent: opts.auditSource ?? "milestones.setup",
    });

  const defs = opts.milestones ?? D9_MILESTONES;
  const have = new Map((await db.milestone.findMany({ where: { tenantId }, select: { id: true, code: true } })).map((m) => [m.code, m.id]));
  for (const [i, d] of defs.entries()) {
    if (have.has(d.code)) continue;
    report.milestonesCreated.push(d.code);
    if (!opts.apply) continue;
    const row = await db.milestone.create({ data: { tenantId, code: d.code, name: d.name, sortOrder: (i + 1) * 10 } });
    have.set(d.code, row.id);
    log("milestone.seed", "Milestone", row.id, { code: d.code, name: d.name, provisional: true, source: "D9 default names" });
  }

  for (const [familyCode, map] of Object.entries(opts.maps ?? { PRESSURE_VESSEL: PV_MILESTONE_MAP })) {
    const family = await db.productFamily.findFirst({ where: { tenantId, code: familyCode }, select: { id: true } });
    if (!family) {
      report.skipped.push(`family ${familyCode} not found`);
      continue;
    }
    const mapped = new Set((await db.milestoneProcessMap.findMany({ where: { familyId: family.id }, select: { processCode: true } })).map((m) => m.processCode));
    let created = 0;
    for (const [processCode, milestoneCode] of Object.entries(map)) {
      if (mapped.has(processCode)) continue;
      created++;
      if (!opts.apply) continue;
      const milestoneId = have.get(milestoneCode);
      if (milestoneId == null) throw new Error(`map for ${familyCode} names unknown milestone ${milestoneCode}`);
      const row = await db.milestoneProcessMap.create({ data: { tenantId, familyId: family.id, processCode, milestoneId } });
      log("milestone.map.seed", "MilestoneProcessMap", row.id, { family: familyCode, processCode, milestone: milestoneCode, provisional: true });
    }
    report.mapsCreated.push({ family: familyCode, count: created });
  }

  if (opts.apply && audit.length > 0) await db.auditLog.createMany({ data: audit });
  return report;
}
