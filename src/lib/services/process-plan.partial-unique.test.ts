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
 * Runs only against despl_test (never despl_demo).
 */

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("ProcessPlan — partial unique index (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let jobId = 0;
  let jobProcessId = 0;
  let scheduleRunId = 0;

  beforeAll(async () => {
    // Find or create test data
    const org = await owner.organization.findUniqueOrThrow({
      where: { code: "DESPL" },
    });
    tenantId = org.id;

    // Find a job with a process
    const job = await owner.job.findFirstOrThrow({
      where: { tenantId },
    });
    jobId = job.id;

    const jobProcess = await owner.jobProcess.findFirstOrThrow({
      where: { jobId },
    });
    jobProcessId = jobProcess.id;

    // Create a test schedule run
    const scheduleRun = await owner.scheduleRun.create({
      data: {
        jobId,
        version: 999,
        mode: "FORWARD",
        projectStartDate: new Date(),
      },
    });
    scheduleRunId = scheduleRun.id;
  });

  afterAll(async () => {
    // Cleanup: delete the test schedule run (cascades to process plans)
    await owner.scheduleRun.deleteMany({
      where: { id: scheduleRunId },
    });
    await owner.$disconnect();
  });

  it("allows multiple ProcessPlan rows with different non-null unitId values for the same (scheduleRunId, jobProcessId)", async () => {
    const department = await owner.department.findFirstOrThrow({
      where: { tenantId },
    });

    // Create two process plans with different unitId values
    const unit1 = await owner.unit.findFirstOrThrow();
    const unit2 = await owner.unit.findFirst({
      where: { id: { not: unit1.id } },
    });

    if (!unit2) {
      // Skip if there's only one unit
      console.warn("Skipping multi-unit test: only one unit exists");
      expect(true).toBe(true);
      return;
    }

    const plan1 = await owner.processPlan.create({
      data: {
        scheduleRunId,
        jobProcessId,
        unitId: unit1.id,
        ownerDepartmentId: department.id,
      },
    });

    const plan2 = await owner.processPlan.create({
      data: {
        scheduleRunId,
        jobProcessId,
        unitId: unit2.id,
        ownerDepartmentId: department.id,
      },
    });

    expect(plan1.unitId).toBe(unit1.id);
    expect(plan2.unitId).toBe(unit2.id);

    // Cleanup
    await owner.processPlan.deleteMany({
      where: { id: { in: [plan1.id, plan2.id] } },
    });
  });

  it("rejects a second ProcessPlan with unitId=NULL for the same (scheduleRunId, jobProcessId) pair", async () => {
    const department = await owner.department.findFirstOrThrow({
      where: { tenantId },
    });

    // Create first null-unitId plan
    const plan1 = await owner.processPlan.create({
      data: {
        scheduleRunId,
        jobProcessId,
        unitId: null,
        ownerDepartmentId: department.id,
      },
    });

    expect(plan1.unitId).toBeNull();

    // Try to create a second null-unitId plan for the same (scheduleRunId, jobProcessId)
    // This should fail due to the partial unique index
    let error: Error | null = null;
    try {
      await owner.processPlan.create({
        data: {
          scheduleRunId,
          jobProcessId,
          unitId: null,
          ownerDepartmentId: department.id,
        },
      });
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/unique/i);

    // Cleanup
    await owner.processPlan.delete({
      where: { id: plan1.id },
    });
  });
});
