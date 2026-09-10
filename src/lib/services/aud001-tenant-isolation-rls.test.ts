import { afterAll, describe, expect, it } from "vitest";

/**
 * AUD-001 — proves the tenant_isolation RESTRICTIVE policy added in
 * 20260909120000_aud001_tenant_isolation_rls actually closes the live-proven
 * cross-tenant read AND write gap on the 28 job_isolation tables
 * (audit/11_DATABASE_AUDIT.md §3.3): with the tenant GUC set to Tenant A and
 * no job GUC, job_isolation alone used to return Tenant B's rows outright —
 * this is the regression guard for that exact reproduction (SET
 * app.tenant_id='<A>'; SELECT ... FROM process_plans; used to return Tenant
 * B's row; UPDATE ... used to actually change it).
 *
 * Same fixture/client split as h1-job-isolation-rls.test.ts and
 * tenant-scoped-views.test.ts: `owner` (DIRECT_URL, bypasses RLS) creates
 * fixtures across TWO real tenants; `prisma`/`withTenant` (despl_web,
 * RLS-subject) makes the assertions.
 *
 * Covers a representative slice of the 28 tables, not all of them — units,
 * process_plans, and qcp_items, all strict NOT-NULL tenant_id tables (the
 * first two are the audit's own reproduction; qcp_items was library-exempt,
 * nullable, when this file was first written — AUD-078 closed that, see
 * aud078-qcp-library-tenant-isolation.test.ts for the library-row behavior).
 * Full breadth across all 28 is rls-coverage.test.ts's job (policy presence,
 * not behavior); this file proves the policy actually behaves correctly for
 * the write path and the exact audit reproduction, which a coverage-only
 * check can't.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("AUD-001 tenant_isolation RLS policy", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { prisma, withTenant } = await import("@/lib/db");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.processPlan.deleteMany({ where: { job: { tenantId } } });
    await owner.scheduleRun.deleteMany({ where: { job: { tenantId } } });
    await owner.jobProcess.deleteMany({ where: { job: { tenantId } } });
    await owner.qcpItem.deleteMany({ where: { qcpTemplate: { job: { tenantId } } } });
    await owner.qcpTemplate.deleteMany({ where: { job: { tenantId } } });
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

  async function fixture(suffix: string) {
    const org = await owner.organization.create({
      data: { code: `TEST-AUD001-${suffix}-${Date.now()}-${Math.random()}`, name: `aud001 ${suffix}` },
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
        publicId: `pub-aud001-${suffix}-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-AUD001-${suffix}-${Date.now()}-${Math.random()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: `Air Receiver ${suffix}` } });
    // NOTE: unit/processPlan created via `owner` (DIRECT_URL, bypasses RLS AND
    // the AUD-001 trigger — no, the trigger fires for every INSERT regardless
    // of role; only RLS itself is bypassed by the table owner). tenant_id is
    // therefore still derived correctly by aud001_derive_tenant_id from job_id.
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
    const qcpTemplate = await owner.qcpTemplate.create({
      data: { jobId: job.id, jobLabel: job.jobNumber, vessel: "Air Receiver" },
    });
    const qcpItem = await owner.qcpItem.create({
      data: {
        qcpTemplateId: qcpTemplate.id,
        jobId: job.id,
        sequence: 1,
        srNo: "1",
        kind: "CHECKPOINT",
        activity: "Hydro test",
      },
    });

    return { tenantId, jobId: job.id, unitId: unit.id, planId: plan.id, qcpItemId: qcpItem.id };
  }

  it("AUD-001 trigger: tenant_id was derived correctly on insert for both strict and library-exempt tables", async () => {
    const a = await fixture("DERIVE");
    const unit = await owner.unit.findUniqueOrThrow({ where: { id: a.unitId } });
    const plan = await owner.processPlan.findUniqueOrThrow({ where: { id: a.planId } });
    const qcpItem = await owner.qcpItem.findUniqueOrThrow({ where: { id: a.qcpItemId } });
    expect(unit.tenantId).toBe(a.tenantId);
    expect(plan.tenantId).toBe(a.tenantId);
    expect(qcpItem.tenantId).toBe(a.tenantId);
  });

  it("fail-open job_isolation preserved: tenant GUC correct, no job GUC -> cross-job reads within the tenant still work", async () => {
    const a = await fixture("A1");
    await withTenant(a.tenantId, async (tx) => {
      const units = await tx.unit.findMany({ where: { id: a.unitId } });
      expect(units).toHaveLength(1);
    });
  });

  it("the audit's exact reproduction, now closed: tenant A's session reading Tenant B's process_plans row by id returns zero rows", async () => {
    const a = await fixture("A2");
    const b = await fixture("B2");
    await withTenant(a.tenantId, async (tx) => {
      const rows = await tx.processPlan.findMany({ where: { id: b.planId } });
      expect(rows).toHaveLength(0);
      const raw = await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM process_plans WHERE id = ${b.planId}
      `;
      expect(raw).toHaveLength(0);
    });
  });

  it("the audit's exact reproduction (write): tenant A's session cannot UPDATE Tenant B's process_plans row", async () => {
    const a = await fixture("A3");
    const b = await fixture("B3");
    await withTenant(a.tenantId, async (tx) => {
      const result = await tx.$executeRaw`
        UPDATE process_plans SET status = 'COMPLETE' WHERE id = ${b.planId}
      `;
      expect(result).toBe(0);
    });
    // Confirm Tenant B's row was NOT modified, checked via the owner connection.
    const untouched = await owner.processPlan.findUniqueOrThrow({ where: { id: b.planId } });
    expect(untouched.status).toBe("NOT_STARTED");
  });

  it("even with the job GUC pointed at the victim's real job (misconfiguration simulation), wrong tenant GUC still returns zero rows", async () => {
    const a = await fixture("A4");
    const b = await fixture("B4");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(a.tenantId)}, true)`;
      await tx.$executeRaw`SELECT set_config('app.job_id', ${String(b.jobId)}, true)`;
      const rows = await tx.unit.findMany({ where: { id: b.unitId } });
      expect(rows).toHaveLength(0);
    });
  });

  it("no tenant GUC set at all -> zero rows on a strict table (fails closed, matching every other tenant_isolation table)", async () => {
    const a = await fixture("A5");
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
      return tx.unit.findMany({ where: { id: a.unitId } });
    });
    expect(rows).toHaveLength(0);
  });

  it("qcp_items: a real job-owned row is tenant-scoped like any strict table", async () => {
    const a = await fixture("A6");
    const b = await fixture("B6");
    await withTenant(a.tenantId, async (tx) => {
      const rows = await tx.qcpItem.findMany({ where: { id: b.qcpItemId } });
      expect(rows).toHaveLength(0);
    });
  });
});
