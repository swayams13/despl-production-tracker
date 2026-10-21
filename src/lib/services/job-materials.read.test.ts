import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * L2.8: the Materials pipeline read (`loadJobMaterials`) and the Dispatch tab's
 * readiness read (`loadDispatchReadiness`). The chip and status rules are
 * table-tested in `shared/job-materials.test.ts`; here the facts are read off
 * real rows (events, lots, transactions, heat records) and a job's tenant fence
 * holds. DB-gated like its siblings: `pnpm test:db`.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("job-materials.read / dispatch readiness (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadJobMaterials } = await import("./job-materials.read");
  const { loadDispatchReadiness } = await import("./dispatch.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.stockTxn.deleteMany({ where: { stockLot: { job: { tenantId } } } });
    await owner.stockLot.deleteMany({ where: { job: { tenantId } } });
    await owner.materialIdentification.deleteMany({ where: { job: { tenantId } } });
    await owner.procurementEvent.deleteMany({ where: { job: { tenantId } } });
    await owner.bomItem.deleteMany({ where: { job: { tenantId } } });
    await owner.unit.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.equipment.deleteMany({ where: { job: { tenantId } } });
    await owner.job.deleteMany({ where: { tenantId } });
    await owner.processTemplateVersion.deleteMany({ where: { template: { tenantId } } });
    await owner.processTemplate.deleteMany({ where: { tenantId } });
    await owner.productFamily.deleteMany({ where: { tenantId } });
    await owner.client.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.organization.delete({ where: { id: tenantId } });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) await deleteOrgAndChildren(id).catch(() => {});
    await owner.$disconnect();
  });

  const actorOf = (tenantId: number, userId: number): Actor => ({
    userId,
    tenantId,
    clientId: null,
    name: "Test",
    email: "t@x",
    roles: [ROLES.PRODUCTION_HEAD] as never,
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM" as const,
    outdoorMode: false,
  });

  async function fixture() {
    const stamp = `${Date.now()}-${Math.random()}`;
    const org = await owner.organization.create({ data: { code: `TEST-JMAT-${stamp}`, name: "job-materials test" } });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${stamp}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: { tenantId, publicId: `pub-jmat-${stamp}`, clientId: client.id, familyId: family.id, templateVersionId: tv.id, jobNumber: `DE-JMAT-${stamp}` },
    });
    const user = await owner.user.create({
      data: { tenantId, email: `jmat-${stamp}@test.local`, username: `jmat-${stamp}`, passwordHash: "x", name: "Test", themePreference: "SYSTEM" },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const units = [];
    for (const serialNo of ["01", "02", "03"]) units.push(await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo } }));
    return { tenantId, job, user, equipment, units, actor: actorOf(tenantId, user.id) };
  }

  it("reads the five chips off events, lots, heat records and issues; required = qty per x units", async () => {
    const { job, user, equipment, actor } = await fixture();
    const item = await owner.bomItem.create({
      data: { jobId: job.id, equipmentId: equipment.id, itemNo: 1, partName: "Shell plate", sourceQty: "2 NOS.", qtyPer: 2, uom: "NOS." },
    });
    for (const type of ["INDENT_RAISED", "PO_PLACED", "RECEIPT"] as const) {
      await owner.procurementEvent.create({ data: { jobId: job.id, bomItemId: item.id, type, qty: type === "RECEIPT" ? 6 : null, by: user.id } });
    }
    const lot = await owner.stockLot.create({ data: { jobId: job.id, bomItemId: item.id, heatNumber: "H-1", location: "Yard", qty: 6 } });
    await owner.materialIdentification.create({ data: { jobId: job.id, bomItemId: item.id, heatNumber: "H-1" } });
    await owner.stockTxn.create({ data: { jobId: job.id, stockLotId: lot.id, type: "ISSUE", qty: 2, by: user.id } });

    const m = await loadJobMaterials(actor, job.id);
    expect(m?.lines).toHaveLength(1);
    const line = m!.lines[0];
    expect(line.requiredQty).toBe(6); // 2 per unit x 3 units
    expect(line.chips.map((c) => c.state)).toEqual(["done", "done", "done", "done", "current"]);
    expect(line.chips[4].detail).toBe("2 of 6"); // issued 2 of 6
    expect(line.status).toBe("ready_to_issue");
    expect(line.heats).toEqual(["H-1"]);
  });

  it("a line with nothing logged is Not started, with no needed-by date (no component route to derive it from)", async () => {
    const { job, equipment, actor } = await fixture();
    await owner.bomItem.create({ data: { jobId: job.id, equipmentId: equipment.id, itemNo: 1, partName: "Gusset", sourceQty: "As required" } });
    const m = await loadJobMaterials(actor, job.id);
    expect(m?.lines[0]).toMatchObject({ requiredQty: null, status: "not_started", neededBy: null, short: false });
    expect(m?.shortCount).toBe(0);
  });

  it("cross-tenant: another tenant's job reads as null", async () => {
    const a = await fixture();
    const b = await fixture();
    expect(await loadJobMaterials(a.actor, b.job.id)).toBeNull();
    expect(await loadDispatchReadiness(a.actor, b.job.id)).toBeNull();
  });

  it("dispatch readiness: a unit with no current schedule is blocked (no production record), not packed", async () => {
    const { job, actor } = await fixture();
    const r = await loadDispatchReadiness(actor, job.id);
    expect(r?.map((u) => u.serialNo)).toEqual(["01", "02", "03"]);
    expect(r?.every((u) => u.blocks.map((b) => b.code).join() === "UNIT_NOT_COMPLETE" && !u.packed && !u.batched)).toBe(true);
  });
});
