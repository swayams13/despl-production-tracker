import { afterAll, describe, expect, it } from "vitest";

/**
 * AUD-080 — proves the job_isolation + tenant_isolation policies added in
 * 20260909140000..20260909180000 for the nine job_id-carrying tables H1/
 * AUD-001 omitted actually behave, not just exist (rls-coverage.test.ts
 * proves existence; this proves behavior, same split as
 * aud001-tenant-isolation-rls.test.ts vs rls-coverage.test.ts).
 *
 * Covers a representative slice, not all nine: `equipments` (a strict,
 * NOT-NULL tenant_id table) and `qcp_templates` (the one library-exempt,
 * nullable tenant_id table in this batch — same shape as qcp_items/
 * inspection_parties/qcp_item_party_codes from the AUD-001 batch).
 *
 * AUD-069 — proves the four job FKs off qcp_templates/qcp_items/
 * inspection_parties/qcp_item_party_codes now RESTRICT job deletion instead
 * of silently promoting the rows into the shared library (20260909190000).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("AUD-080 RLS on the remaining nine tables + AUD-069 QCP delete RESTRICT", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { prisma, withTenant } = await import("@/lib/db");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.qcpItem.deleteMany({ where: { qcpTemplate: { job: { tenantId } } } });
    await owner.qcpTemplate.deleteMany({ where: { job: { tenantId } } });
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
      data: { code: `TEST-AUD080-${suffix}-${Date.now()}-${Math.random()}`, name: `aud080 ${suffix}` },
    });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({
      data: { tenantId, name: "ACME", code: `ACME-${suffix}-${Date.now()}-${Math.random()}` },
    });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-aud080-${suffix}-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-AUD080-${suffix}-${Date.now()}-${Math.random()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: `Air Receiver ${suffix}` } });
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

    return { tenantId, jobId: job.id, equipmentId: equipment.id, qcpTemplateId: qcpTemplate.id, qcpItemId: qcpItem.id };
  }

  it("AUD-080 trigger: tenant_id derived correctly on insert for both a strict table (equipments) and the library-exempt one (qcp_templates)", async () => {
    const a = await fixture("DERIVE");
    const equipment = await owner.equipment.findUniqueOrThrow({ where: { id: a.equipmentId } });
    const qcpTemplate = await owner.qcpTemplate.findUniqueOrThrow({ where: { id: a.qcpTemplateId } });
    expect(equipment.tenantId).toBe(a.tenantId);
    expect(qcpTemplate.tenantId).toBe(a.tenantId);
  });

  it("fail-open job_isolation: tenant GUC correct, no job GUC -> cross-job reads within the tenant still work", async () => {
    const a = await fixture("A1");
    await withTenant(a.tenantId, async (tx) => {
      const rows = await tx.equipment.findMany({ where: { id: a.equipmentId } });
      expect(rows).toHaveLength(1);
    });
  });

  it("tenant A reading tenant B's equipments row by id returns zero rows", async () => {
    const a = await fixture("A2");
    const b = await fixture("B2");
    await withTenant(a.tenantId, async (tx) => {
      const rows = await tx.equipment.findMany({ where: { id: b.equipmentId } });
      expect(rows).toHaveLength(0);
    });
  });

  it("tenant A writing to tenant B's equipments row affects zero rows", async () => {
    const a = await fixture("A3");
    const b = await fixture("B3");
    await withTenant(a.tenantId, async (tx) => {
      const result = await tx.$executeRaw`UPDATE equipments SET remarks = 'hacked' WHERE id = ${b.equipmentId}`;
      expect(result).toBe(0);
    });
    const untouched = await owner.equipment.findUniqueOrThrow({ where: { id: b.equipmentId } });
    expect(untouched.remarks).not.toBe("hacked");
  });

  it("no tenant GUC set at all -> zero rows on a strict table (fails closed)", async () => {
    const a = await fixture("A4");
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
      return tx.equipment.findMany({ where: { id: a.equipmentId } });
    });
    expect(rows).toHaveLength(0);
  });

  it("library-exempt table (qcp_templates): a real job-owned row is still tenant-scoped", async () => {
    const a = await fixture("A5");
    const b = await fixture("B5");
    await withTenant(a.tenantId, async (tx) => {
      const rows = await tx.qcpTemplate.findMany({ where: { id: b.qcpTemplateId } });
      expect(rows).toHaveLength(0);
    });
  });

  it("AUD-069: deleting a job with an attached QcpTemplate/QcpItem is refused (RESTRICT, not silently promoted to the library)", async () => {
    const a = await fixture("DEL1");
    await expect(owner.job.delete({ where: { id: a.jobId } })).rejects.toThrow();
    // Confirm the job and its QCP rows are untouched, not orphaned into the library.
    const template = await owner.qcpTemplate.findUniqueOrThrow({ where: { id: a.qcpTemplateId } });
    expect(template.jobId).toBe(a.jobId);
  });

  it("AUD-069: deleting a job with zero QCP rows attached still succeeds", async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-AUD069-NOQCP-${Date.now()}-${Math.random()}`, name: "aud069 noqcp" },
    });
    createdOrgIds.push(org.id);
    const client = await owner.client.create({
      data: { tenantId: org.id, name: "ACME", code: `ACME-NOQCP-${Date.now()}-${Math.random()}` },
    });
    const family = await owner.productFamily.create({ data: { tenantId: org.id, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId: org.id, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId: org.id,
        publicId: `pub-aud069-noqcp-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-AUD069-NOQCP-${Date.now()}-${Math.random()}`,
      },
    });
    await expect(owner.job.delete({ where: { id: job.id } })).resolves.toBeTruthy();
  });
});
