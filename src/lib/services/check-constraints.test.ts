import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * AUD-006 — regression coverage for the CHECK constraint set added in
 * `20260910100000_aud006_check_constraints` (`11_DATABASE_AUDIT.md` §10,
 * items 1-7). Each `it()` proves one impossible state, previously reachable
 * from the app's own `despl_web` role (`11_DATABASE_AUDIT.md` §6), is now
 * rejected at the database layer — a raw `owner.$executeRawUnsafe` UPDATE so
 * the constraint is exercised directly, independent of whatever the
 * service-layer write path happens to validate today.
 *
 * Same disposable-org, no-cleanup pattern as `bom.read.test.ts` — gated
 * behind RUN_DB_TESTS (`pnpm test:db`).
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("CHECK constraints (AUD-006, DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let jobId = 0;
  let departmentId = 0;
  let jobProcessId = 0;
  let scheduleRunId = 0;
  let processPlanId = 0;
  let componentOperationId = 0;
  let assemblyStepId = 0;
  let stockLotId = 0;
  let templateProcessId = 0;
  let ncrId = 0;
  let userId = 0;

  afterAll(async () => {
    await owner.$disconnect();
  });

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `TEST-CHK-${Date.now()}`, name: "check-constraints test" } });
    tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    departmentId = dept.id;
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-chk-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `JOB-CHK-${Date.now()}`,
      },
    });
    jobId = job.id;
    userId = (
      await owner.user.create({
        data: { tenantId, email: `chk-${Date.now()}@test.local`, username: `chk-${Date.now()}`, passwordHash: "x", name: "Test User", themePreference: "SYSTEM" },
      })
    ).id;

    // process_plans / job_processes
    const jobProcess = await owner.jobProcess.create({
      data: { jobId, seq: 1, code: "P1", name: "Test process", departmentId, workOrderStages: [1] },
    });
    jobProcessId = jobProcess.id;
    const scheduleRun = await owner.scheduleRun.create({
      data: { jobId, version: 1, mode: "FORWARD", projectStartDate: new Date() },
    });
    scheduleRunId = scheduleRun.id;
    const plan = await owner.processPlan.create({
      data: { jobId, scheduleRunId, jobProcessId, ownerDepartmentId: departmentId },
    });
    processPlanId = plan.id;

    // template_processes
    templateProcessId = (
      await owner.templateProcess.create({
        data: { versionId: tv.id, seq: 1, code: "T1", name: "Test template process", defaultDepartmentId: departmentId },
      })
    ).id;

    // component_operations
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const operation = await owner.operationRef.create({ data: { tenantId, code: "CUTTING", name: "Cutting" } });
    const equipment = await owner.equipment.create({ data: { jobId, name: "Air Receiver" } });
    const bomItem = await owner.bomItem.create({
      data: { jobId, equipmentId: equipment.id, itemNo: 1, partName: "Shell", sourceQty: "1", componentTypeId: componentType.id },
    });
    stockLotId = (await owner.stockLot.create({ data: { jobId, bomItemId: bomItem.id, location: "Yard A", qty: 10 } })).id;
    const component = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, bomItemId: bomItem.id, tag: "SHELL-1", componentTypeId: componentType.id },
    });
    componentOperationId = (
      await owner.componentOperation.create({ data: { jobId, componentId: component.id, seq: 1, operationId: operation.id } })
    ).id;

    // assembly_steps
    const unit = await owner.unit.create({ data: { jobId, equipmentId: equipment.id, serialNo: "01" } });
    const asmTemplate = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "A-Q" } });
    const asmVersion = await owner.assemblyTemplateVersion.create({ data: { templateId: asmTemplate.id, version: 1 } });
    const templateStep = await owner.assemblyTemplateStep.create({
      data: { versionId: asmVersion.id, seq: 1, groupCode: "C", groupName: "Shell Prep", srNo: "4.1", activity: "Cut", kind: "WORK", defaultDepartmentId: departmentId },
    });
    assemblyStepId = (
      await owner.assemblyStep.create({ data: { jobId, unitId: unit.id, templateStepId: templateStep.id, seq: 1 } })
    ).id;

    // ncrs — needs one rejection row as its exactly-one-source parent.
    const category = await owner.delayCategoryRef.create({ data: { tenantId, code: "TEST-CAT", name: "Test category" } });
    const rejection = await owner.componentOperationRejection.create({
      data: { jobId, componentOperationId, categoryId: category.id, rejectedBy: userId },
    });
    ncrId = (await owner.ncr.create({ data: { jobId, componentOperationRejectionId: rejection.id } })).id;
  });

  it("rejects process_plans/component_operations/assembly_steps with actual/finished before start", async () => {
    await expect(
      owner.$executeRawUnsafe(
        `UPDATE process_plans SET actual_start = now(), actual_finish = now() - interval '1 day' WHERE id = $1`,
        processPlanId,
      ),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      owner.$executeRawUnsafe(
        `UPDATE component_operations SET started_at = now(), finished_at = now() - interval '1 day' WHERE id = $1`,
        componentOperationId,
      ),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      owner.$executeRawUnsafe(
        `UPDATE assembly_steps SET started_at = now(), finished_at = now() - interval '1 day' WHERE id = $1`,
        assemblyStepId,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects progress_snapshots with overall_pct outside 0-100", async () => {
    const base = { tenantId, jobId, asOf: new Date(), status: "PUBLISHED" as const };
    await expect(owner.progressSnapshot.create({ data: { ...base, overallPct: 250 } })).rejects.toThrow(/check constraint/i);
    await expect(owner.progressSnapshot.create({ data: { ...base, overallPct: -40 } })).rejects.toThrow(/check constraint/i);
  });

  it("rejects job_processes/template_processes with non-positive or inverted durations", async () => {
    await expect(
      owner.jobProcess.update({ where: { id: jobProcessId }, data: { durationMinDays: -5 } }),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      owner.jobProcess.update({ where: { id: jobProcessId }, data: { durationMinDays: 5, durationMaxDays: 1 } }),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      owner.templateProcess.update({ where: { id: templateProcessId }, data: { durationMinDays: -5 } }),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      owner.templateProcess.update({ where: { id: templateProcessId }, data: { durationMinDays: 5, durationMaxDays: 1 } }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects stock_txns with qty<=0 and stock_lots with qty<0", async () => {
    await expect(
      owner.stockTxn.create({ data: { jobId, stockLotId, type: "ISSUE", qty: -500, by: userId } }),
    ).rejects.toThrow(/check constraint/i);
    await expect(owner.stockLot.update({ where: { id: stockLotId }, data: { qty: -9999 } })).rejects.toThrow(/check constraint/i);
  });

  it("rejects component_operations quantities that are negative or exceed qtyPlanned", async () => {
    await expect(
      owner.componentOperation.update({ where: { id: componentOperationId }, data: { qtyGood: -1 } }),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      owner.componentOperation.update({ where: { id: componentOperationId }, data: { qtyPlanned: 10, qtyGood: 8, qtyRejected: 5 } }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects process_plans COMPLETE without actual_finish, and ncrs CLOSED without closed_by/closed_at", async () => {
    await expect(
      owner.$executeRawUnsafe(`UPDATE process_plans SET status = 'COMPLETE' WHERE id = $1`, processPlanId),
    ).rejects.toThrow(/check constraint/i);

    await expect(owner.ncr.update({ where: { id: ncrId }, data: { status: "CLOSED" } })).rejects.toThrow(/check constraint/i);
  });
});
