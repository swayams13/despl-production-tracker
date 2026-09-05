import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ProcessPlan partial unique index regression test (B10, Phase 4).
 *
 * PostgreSQL treats NULL as distinct in a regular unique constraint,
 * so the old @@unique([scheduleRunId, jobProcessId, unitId]) could not
 * prevent duplicate (scheduleRunId, jobProcessId, NULL) pairs. This test
 * proves the partial unique index now correctly prevents that case while
 * still allowing multiple non-null unitId values for the same
 * (scheduleRunId, jobProcessId) pair.
 *
 * Builds its own disposable org/job/jobProcess/units rather than reading the
 * shared seeded "DESPL" tenant's "first Job"/"first JobProcess" (its
 * original shape, pre-4 Sep 2026): those two lookups carried no `orderBy`,
 * so which job/jobProcess row Postgres actually returned was never
 * guaranteed by SQL semantics — it depended on physical row order, which
 * shifts under seed-script/schema changes with no relation to this test's
 * own logic. It broke for exactly that reason once another PR's unrelated
 * test file changed vitest's DB-tier file scheduling. Every sibling
 * DB-gated test file in this codebase (dispatch.service.test.ts,
 * packing.read.test.ts, dispatch.read.test.ts, …) already uses this
 * disposable-fixture pattern for the same reason — this file just hadn't
 * been migrated to it yet.
 */

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("ProcessPlan — partial unique index (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let departmentId = 0;
  let jobId = 0;
  let jobProcessId = 0;
  let scheduleRunId = 0;
  let unit1Id = 0;
  let unit2Id = 0;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-PPUNIQ-${Date.now()}-${Math.random()}`, name: "process-plan partial-unique test" },
    });
    tenantId = org.id;
    const department = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    departmentId = department.id;
    const client = await owner.client.create({
      data: { tenantId, name: "ACME", code: `ACME-${Date.now()}-${Math.random()}` },
    });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-ppuniq-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-PPUNIQ-${Date.now()}-${Math.random()}`,
      },
    });

    jobId = job.id;
    const jobProcess = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 1, code: "P1", name: "Test process", departmentId, workOrderStages: [1] },
    });
    jobProcessId = jobProcess.id;

    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unit1 = await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "01" } });
    const unit2 = await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "02" } });
    unit1Id = unit1.id;
    unit2Id = unit2.id;

    const scheduleRun = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date() },
    });
    scheduleRunId = scheduleRun.id;
  });

  afterAll(async () => {
    await owner.processPlan.deleteMany({ where: { scheduleRunId } });
    await owner.scheduleRun.deleteMany({ where: { id: scheduleRunId } });
    await owner.unit.deleteMany({ where: { id: { in: [unit1Id, unit2Id] } } });
    await owner.equipment.deleteMany({ where: { job: { tenantId } } });
    await owner.jobProcess.deleteMany({ where: { id: jobProcessId } });
    await owner.job.deleteMany({ where: { tenantId } });
    await owner.processTemplateVersion.deleteMany({ where: { template: { tenantId } } });
    await owner.processTemplate.deleteMany({ where: { tenantId } });
    await owner.productFamily.deleteMany({ where: { tenantId } });
    await owner.client.deleteMany({ where: { tenantId } });
    await owner.department.deleteMany({ where: { tenantId } });
    await owner.organization.delete({ where: { id: tenantId } });
    await owner.$disconnect();
  });

  it("allows multiple ProcessPlan rows with different non-null unitId values for the same (scheduleRunId, jobProcessId)", async () => {
    const plan1 = await owner.processPlan.create({
      data: { jobId, scheduleRunId, jobProcessId, unitId: unit1Id, ownerDepartmentId: departmentId },
    });
    const plan2 = await owner.processPlan.create({
      data: { jobId, scheduleRunId, jobProcessId, unitId: unit2Id, ownerDepartmentId: departmentId },
    });

    expect(plan1.unitId).toBe(unit1Id);
    expect(plan2.unitId).toBe(unit2Id);

    await owner.processPlan.deleteMany({ where: { id: { in: [plan1.id, plan2.id] } } });
  });

  it("rejects a second ProcessPlan with unitId=NULL for the same (scheduleRunId, jobProcessId) pair", async () => {
    const plan1 = await owner.processPlan.create({
      data: { jobId, scheduleRunId, jobProcessId, unitId: null, ownerDepartmentId: departmentId },
    });
    expect(plan1.unitId).toBeNull();

    let error: Error | null = null;
    try {
      await owner.processPlan.create({
        data: { jobId, scheduleRunId, jobProcessId, unitId: null, ownerDepartmentId: departmentId },
      });
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/unique/i);

    await owner.processPlan.delete({ where: { id: plan1.id } });
  });
});
