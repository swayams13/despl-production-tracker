import { afterAll, describe, expect, it } from "vitest";

/**
 * AUD-002 (interim) — proves the tenant predicate added in
 * 20260908100000_tenant_scoped_status_views closes the cross-tenant leak in
 * v_unit_stage_status and v_process_plan_percent: both views join job-grain
 * tables (units/equipments/job_processes/process_plans) covered only by the
 * fail-open job_isolation policy (AUD-001), so on the normal read path
 * (app.tenant_id set, app.job_id NOT set) they used to return every
 * tenant's rows. Same fixture/client split as h1-job-isolation-rls.test.ts.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("tenant-scoped status views (AUD-002)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { prisma } = await import("@/lib/db");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.processPlan.deleteMany({ where: { job: { tenantId } } });
    await owner.scheduleRun.deleteMany({ where: { job: { tenantId } } });
    await owner.jobProcess.deleteMany({ where: { job: { tenantId } } });
    await owner.unit.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.equipment.deleteMany({ where: { job: { tenantId } } });
    await owner.job.deleteMany({ where: { tenantId } });
    await owner.processTemplateVersion.deleteMany({ where: { template: { tenantId } } });
    await owner.processTemplate.deleteMany({ where: { tenantId } });
    await owner.productFamily.deleteMany({ where: { tenantId } });
    await owner.client.deleteMany({ where: { tenantId } });
    await owner.department.deleteMany({ where: { tenantId } });
    await owner.organization.delete({ where: { id: tenantId } });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await deleteOrgAndChildren(id).catch(() => {});
    }
    await owner.$disconnect();
  });

  async function makeTenant(suffix: string) {
    const org = await owner.organization.create({
      data: { code: `TEST-AUD002-${suffix}-${Date.now()}-${Math.random()}`, name: `aud002 ${suffix}` },
    });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const dept = await owner.department.create({
      data: { tenantId, code: `PROD-${suffix}`, name: "Production" },
    });
    const client = await owner.client.create({
      data: { tenantId, name: "ACME", code: `ACME-${suffix}-${Date.now()}-${Math.random()}` },
    });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-aud002-${suffix}-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-AUD002-${suffix}-${Date.now()}-${Math.random()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: `Air Receiver ${suffix}` } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "01" } });
    const jobProcess = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 1, code: "1", name: "Test process", departmentId: dept.id, workOrderStages: [1] },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    const plan = await owner.processPlan.create({
      data: {
        jobId: job.id,
        scheduleRunId: run.id,
        jobProcessId: jobProcess.id,
        unitId: unit.id,
        ownerDepartmentId: dept.id,
        status: "NOT_STARTED",
      },
    });
    return { tenantId, jobId: job.id, unitId: unit.id, planId: plan.id };
  }

  async function asTenant<T>(tenantId: number, fn: (tx: import("@/lib/db").Tx) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      return fn(tx);
    });
  }

  it("v_unit_stage_status: only tenant A's rows come back when app.tenant_id is set to A and app.job_id is unset", async () => {
    const a = await makeTenant("A1");
    const b = await makeTenant("B1");
    const rows = await asTenant(
      a.tenantId,
      (tx) => tx.$queryRaw<{ job_id: number; unit_id: number }[]>`
        SELECT job_id, unit_id FROM v_unit_stage_status WHERE unit_id IN (${a.unitId}, ${b.unitId})
      `,
    );
    expect(rows.map((r) => r.unit_id)).toEqual([a.unitId]);
  });

  it("v_process_plan_percent: only tenant A's rows come back when app.tenant_id is set to A and app.job_id is unset", async () => {
    const a = await makeTenant("A2");
    const b = await makeTenant("B2");
    const rows = await asTenant(
      a.tenantId,
      (tx) => tx.$queryRaw<{ process_plan_id: number }[]>`
        SELECT process_plan_id FROM v_process_plan_percent WHERE process_plan_id IN (${a.planId}, ${b.planId})
      `,
    );
    expect(rows.map((r) => r.process_plan_id)).toEqual([a.planId]);
  });

  it("app.tenant_id='' (pooled-connection GUC reset) returns zero rows from both views, no thrown error", async () => {
    const a = await makeTenant("A3");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
      const unitRows = await tx.$queryRaw<unknown[]>`
        SELECT job_id, unit_id FROM v_unit_stage_status WHERE unit_id = ${a.unitId}
      `;
      expect(unitRows).toHaveLength(0);
      const planRows = await tx.$queryRaw<unknown[]>`
        SELECT process_plan_id FROM v_process_plan_percent WHERE process_plan_id = ${a.planId}
      `;
      expect(planRows).toHaveLength(0);
    });
  });

  it("tenant A's own rows still come back correctly-shaped with app.tenant_id set correctly", async () => {
    const a = await makeTenant("A4");
    const unitRows = await asTenant(
      a.tenantId,
      (tx) => tx.$queryRaw<{ job_id: number; unit_id: number; stage_no: number; fill_status: string }[]>`
        SELECT job_id, unit_id, stage_no, fill_status FROM v_unit_stage_status WHERE unit_id = ${a.unitId}
      `,
    );
    expect(unitRows).toHaveLength(1);
    expect(unitRows[0]).toMatchObject({ job_id: a.jobId, unit_id: a.unitId, stage_no: 1, fill_status: "idle" });

    const planRows = await asTenant(
      a.tenantId,
      (tx) => tx.$queryRaw<{ process_plan_id: number; job_id: number; percent: unknown }[]>`
        SELECT process_plan_id, job_id, percent FROM v_process_plan_percent WHERE process_plan_id = ${a.planId}
      `,
    );
    expect(planRows).toHaveLength(1);
    expect(planRows[0].job_id).toBe(a.jobId);
    expect(Number(planRows[0].percent)).toBe(0);
  });
});
