import { afterAll, describe, expect, it } from "vitest";

/**
 * H1 (Task 4) — proves the `job_isolation` RLS policy
 * (20260905090000_h1_job_isolation_rls) is fail-OPEN when `app.job_id` is
 * unset (every existing cross-job read keeps working unmodified) and
 * actually narrows the result set once a caller sets `app.job_id` — the
 * "id from Job B passed into a Job A operation" backstop the whole H1 plan
 * exists for.
 *
 * Uses the despl_web (RLS-subject) client for the assertions and a direct
 * owner client (DIRECT_URL, bypasses RLS) only for fixture setup/teardown —
 * same split every other DB-gated test in this file uses.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("H1 job_isolation RLS policy", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { prisma, withTenant } = await import("@/lib/db");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.unit.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.equipment.deleteMany({ where: { job: { tenantId } } });
    await owner.job.deleteMany({ where: { tenantId } });
    await owner.processTemplateVersion.deleteMany({ where: { template: { tenantId } } });
    await owner.processTemplate.deleteMany({ where: { tenantId } });
    await owner.productFamily.deleteMany({ where: { tenantId } });
    await owner.client.deleteMany({ where: { tenantId } });
    await owner.organization.delete({ where: { id: tenantId } });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await deleteOrgAndChildren(id).catch(() => {});
    }
    await owner.$disconnect();
  });

  async function fixture() {
    const org = await owner.organization.create({
      data: { code: `TEST-H1-RLS-${Date.now()}-${Math.random()}`, name: "h1 rls test" },
    });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({
      data: { tenantId, name: "ACME", code: `ACME-${Date.now()}-${Math.random()}` },
    });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const jobA = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-h1-a-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-H1-A-${Date.now()}-${Math.random()}`,
      },
    });
    const jobB = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-h1-b-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-H1-B-${Date.now()}-${Math.random()}`,
      },
    });
    const equipmentA = await owner.equipment.create({ data: { jobId: jobA.id, name: "Air Receiver A" } });
    const equipmentB = await owner.equipment.create({ data: { jobId: jobB.id, name: "Air Receiver B" } });
    const unitA = await owner.unit.create({ data: { jobId: jobA.id, equipmentId: equipmentA.id, serialNo: "01" } });
    const unitB = await owner.unit.create({ data: { jobId: jobB.id, equipmentId: equipmentB.id, serialNo: "01" } });

    return { tenantId, jobAId: jobA.id, jobBId: jobB.id, unitAId: unitA.id, unitBId: unitB.id };
  }

  it("with app.job_id unset, a query sees rows from BOTH jobs (fail-open preserved)", async () => {
    const { tenantId, unitAId, unitBId } = await fixture();
    await withTenant(tenantId, async (tx) => {
      const units = await tx.unit.findMany({ where: { id: { in: [unitAId, unitBId] } } });
      expect(units).toHaveLength(2);
    });
  });

  it("with app.job_id set to Job A, a query for Job B's unit id returns ZERO rows", async () => {
    const { tenantId, jobAId, unitBId } = await fixture();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      await tx.$executeRaw`SELECT set_config('app.job_id', ${String(jobAId)}, true)`;
      const unit = await tx.unit.findFirst({ where: { id: unitBId } });
      expect(unit).toBeNull();
    });
  });

  it("with app.job_id set to Job A, a query for Job A's own unit still succeeds", async () => {
    const { tenantId, jobAId, unitAId } = await fixture();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      await tx.$executeRaw`SELECT set_config('app.job_id', ${String(jobAId)}, true)`;
      const unit = await tx.unit.findFirst({ where: { id: unitAId } });
      expect(unit?.id).toBe(unitAId);
    });
  });
});
