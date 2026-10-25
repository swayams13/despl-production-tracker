// Lean Core L1.2h: publish a NEW version of the family assembly template whose steps carry the floor facts the
// HARD rules read (role, joint, pressure flag), from the reviewed mapping. Published v1 on an environment that
// predates L1.2 has none, and every new job copies them from its template step at BOM release, so without this
// the weld order (H1), PWHT (H4, H5) and hydro (H4, H6) rules are silently off for new jobs. One implementation
// for scripts/lean-publish-assembly-roles.ts and its test. Relative imports only: runs under tsx as the owner.
import type { Prisma } from "../../generated/prisma/client";
import { planTemplateRoles, type RoleFacts } from "../shared/template-roles";

type Db = Prisma.TransactionClient;

export interface AssemblyRolesReport {
  sourceVersion: number | null;
  /** The version written (apply) or that would be written (dry run); null when there is nothing to do. */
  newVersion: number | null;
  filled: number;
  already: number;
  /** Why nothing was written (no family, no published version, mapping does not match, ...). */
  skipped: string[];
}

/**
 * Reads always; writes only when `apply`. Copies the newest PUBLISHED family version into the next version number
 * (published, like J1's copy) and fills only facts that are empty on the source. The source is never edited
 * (invariant 9); running jobs keep their pin. A second run finds nothing to fill.
 */
export async function ensureAssemblyRoles(
  db: Db,
  tenantId: number,
  opts: {
    apply: boolean;
    mapping: ReadonlyArray<RoleFacts & { seq: number }>;
    mappingStatus: string;
    audit?: boolean;
    auditSource?: string;
  },
): Promise<AssemblyRolesReport> {
  const report: AssemblyRolesReport = { sourceVersion: null, newVersion: null, filled: 0, already: 0, skipped: [] };

  const family = await db.productFamily.findFirst({ where: { tenantId, code: "PRESSURE_VESSEL" } });
  if (!family) {
    report.skipped.push("family PRESSURE_VESSEL not found");
    return report;
  }
  const template = await db.assemblyTemplate.findFirst({ where: { tenantId, familyId: family.id, equipmentTypeId: null }, orderBy: { id: "asc" } });
  const source = template
    ? await db.assemblyTemplateVersion.findFirst({
        where: { templateId: template.id, status: "PUBLISHED", steps: { some: {} } },
        orderBy: { version: "desc" },
        include: { steps: { orderBy: { seq: "asc" } } },
      })
    : null;
  if (!template || !source) {
    report.skipped.push("no published family assembly template to fill");
    return report;
  }
  report.sourceVersion = source.version;

  const plan = planTemplateRoles(source.steps, opts.mapping);
  report.already = plan.already;
  if (plan.unmapped.length > 0 || plan.unknown.length > 0) {
    report.skipped.push(
      `the mapping does not match v${source.version}: template steps without a row [${plan.unmapped.join(",")}], mapping rows without a step [${plan.unknown.join(",")}]`,
    );
    return report;
  }
  report.filled = plan.fills.length;
  if (plan.fills.length === 0) return report;

  const latest = await db.assemblyTemplateVersion.aggregate({ where: { templateId: template.id }, _max: { version: true } });
  report.newVersion = (latest._max.version ?? source.version) + 1;
  if (!opts.apply) return report;

  const created = await db.assemblyTemplateVersion.create({
    data: {
      templateId: template.id,
      version: report.newVersion,
      status: "PUBLISHED",
      publishedAt: new Date(),
      notes: `L1.2h: step roles, joints and pressure flags filled from the reviewed mapping (${opts.mappingStatus}); copy of v${source.version}`,
    },
  });
  const set = new Map(plan.fills.map((f) => [f.seq, f.set]));
  await db.assemblyTemplateStep.createMany({
    data: source.steps.map(({ id: _id, versionId: _versionId, includeWhen, role, ...step }) => {
      const fill = set.get(step.seq) ?? {};
      return {
        ...step,
        versionId: created.id,
        // a Json column copies as undefined (SQL NULL) or the rule itself
        includeWhen: includeWhen === null ? undefined : (includeWhen as Prisma.InputJsonValue),
        role: (fill.role ?? role) as typeof role,
        ...(fill.jointRef !== undefined ? { jointRef: fill.jointRef } : {}),
        ...(fill.pressurePart !== undefined ? { pressurePart: fill.pressurePart } : {}),
      };
    }),
  });
  if (opts.audit) {
    await db.auditLog.create({
      data: {
        tenantId,
        actorId: null,
        action: "setup.assemblyTemplate.roles",
        entityType: "AssemblyTemplateVersion",
        entityId: String(created.id),
        after: { copiedFromVersionId: source.id, copiedFromVersion: source.version, newVersion: created.version, stepsFilled: plan.fills.length, mappingStatus: opts.mappingStatus } as never,
        userAgent: opts.auditSource ?? "assembly-roles.setup",
      },
    });
  }
  return report;
}
