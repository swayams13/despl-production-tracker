import { afterAll, describe, expect, it } from "vitest";

/**
 * L1.2h follow-up: `pnpm db:seed` itself publishes PV assembly template v2 with the step roles, so a fresh install
 * needs no extra `lean-publish-assembly-roles.ts` run. Compares the seeded DB with what the script would produce
 * (pure planTemplateRoles over v1 and the reviewed mapping) and checks the script is then a no-op, v1 is untouched
 * (invariant 9) and DESPL-320 stays pinned to role-less v1. Read-only; skips when the DB is not seeded.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("db:seed publishes assembly template v2 with step roles (DB, seeded)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { ensureAssemblyRoles } = await import("./assembly-roles.setup");
  const { planTemplateRoles } = await import("@/lib/shared/template-roles");
  const { loadMapping } = await import("../../../scripts/lean-backfill-floor-facts");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const mapping = loadMapping();
  const facts = (steps: { seq: number; role: string | null; jointRef: string | null; pressurePart: boolean }[]) =>
    steps.map(({ seq, role, jointRef, pressurePart }) => ({ seq, role, jointRef, pressurePart }));

  async function world() {
    const org = await owner.organization.findUnique({ where: { code: "DESPL" }, select: { id: true } });
    if (!org) return null;
    const template = await owner.assemblyTemplate.findFirst({
      where: { tenantId: org.id, equipmentTypeId: null, family: { code: "PRESSURE_VESSEL" } },
      include: { versions: { orderBy: { version: "asc" }, include: { steps: { orderBy: { seq: "asc" } } } } },
    });
    return template ? { tenantId: org.id, template } : null;
  }

  it("v2 carries exactly the facts the script's plan would fill into v1 (31 roles, 25 pressure flags)", async () => {
    const w = await world();
    if (!w) return;
    const [v1, v2] = w.template.versions;
    expect(w.template.versions.map((v) => v.version)).toEqual([1, 2]);
    const plan = planTemplateRoles(v1.steps, mapping.steps);
    expect(plan.unmapped).toEqual([]);
    expect(plan.unknown).toEqual([]);
    const expected = facts(v1.steps).map((s) => ({ ...s, ...(plan.fills.find((f) => f.seq === s.seq)?.set ?? {}) }));
    expect(facts(v2.steps)).toEqual(expected);
    expect(v2.steps.filter((s) => s.role !== null)).toHaveLength(31);
    expect(v2.steps.filter((s) => s.pressurePart)).toHaveLength(25);
    expect(v2.status).toBe("PUBLISHED");
  });

  it("v1 stays role-less (invariant 9)", async () => {
    const w = await world();
    if (!w) return;
    const v1 = w.template.versions[0];
    expect(v1.steps.filter((s) => s.role !== null || s.pressurePart)).toEqual([]);
  });

  it("the publish script is a no-op on the seeded database", async () => {
    const w = await world();
    if (!w) return;
    const r = await owner.$transaction((tx) =>
      ensureAssemblyRoles(tx, w.tenantId, { apply: false, mapping: mapping.steps, mappingStatus: mapping.reviewStatus }),
    );
    expect(r).toMatchObject({ sourceVersion: 2, newVersion: null, filled: 0, already: 54, skipped: [] });
  });

  it("the skirt type's template (what new vertical-on-skirt jobs copy) carries the same facts as v2", async () => {
    const w = await world();
    if (!w) return;
    const skirt = await owner.assemblyTemplate.findFirst({
      where: { tenantId: w.tenantId, equipmentType: { code: "PV-VERT-SKIRT" } },
      include: { versions: { include: { steps: { orderBy: { seq: "asc" } } } } },
    });
    expect(skirt).not.toBeNull();
    expect(facts(skirt!.versions[0].steps)).toEqual(facts(w.template.versions[1].steps));
  });

  it("DESPL-320 is unchanged: pinned to role-less v1, its steps have no roles", async () => {
    const w = await world();
    if (!w) return;
    const job = await owner.job.findFirst({ where: { tenantId: w.tenantId, jobNumber: "DESPL-320" }, select: { id: true, assemblyTemplateVersionId: true } });
    if (!job) return;
    expect(job.assemblyTemplateVersionId).toBe(w.template.versions[0].id);
    expect(await owner.assemblyStep.count({ where: { jobId: job.id, OR: [{ role: { not: null } }, { pressurePart: true }] } })).toBe(0);
  });
});
