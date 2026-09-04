import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * S9 — DB-backed coverage for `loadDispatchPanel`: batches derive their
 * display status from `deriveDispatchBatchStatus` (dispatch.service.ts) —
 * this read model must never invent a second status source — and the
 * packed-units list (packageId set, job-wide) seeds the add-to-batch picker.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("dispatch.read — loadDispatchPanel (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadDispatchPanel } = await import("./dispatch.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.dispatchBatchUnit.deleteMany({ where: { dispatchBatch: { job: { tenantId } } } });
    await owner.dispatchBatch.deleteMany({ where: { job: { tenantId } } });
    await owner.unit.updateMany({ where: { equipment: { job: { tenantId } } }, data: { packageId: null } });
    await owner.package.deleteMany({ where: { job: { tenantId } } });
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
    for (const id of createdOrgIds) {
      await deleteOrgAndChildren(id).catch(() => {});
    }
    await owner.$disconnect();
  });

  function actorBase(tenantId: number, userId: number, roles: string[] = []): Actor {
    return {
      userId,
      tenantId,
      clientId: null,
      name: "Test",
      email: "t@x",
      roles: roles as never,
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM" as const,
      outdoorMode: false,
    };
  }

  async function fixture() {
    const org = await owner.organization.create({
      data: { code: `TEST-DISPREAD-${Date.now()}-${Math.random()}`, name: "dispatch.read test" },
    });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({
      data: { tenantId, name: "ACME", code: `ACME-${Date.now()}-${Math.random()}` },
    });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-dispread-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-DISPREAD-${Date.now()}-${Math.random()}`,
      },
    });
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `dispread-${Date.now()}-${Math.random()}@test.local`,
        username: `dispread-${Date.now()}-${Math.random()}`,
        passwordHash: "x",
        name: "Test PH",
        themePreference: "SYSTEM",
      },
    });
    return { tenantId, job, user };
  }

  it("a job with no batches/units returns empty batches and packedUnits, not null", async () => {
    const { tenantId, job, user } = await fixture();
    const actor = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const panel = await loadDispatchPanel(actor, job.id);
    expect(panel).toEqual({ batches: [], packedUnits: [] });
  });

  it("a PLANNED batch with one unit reports status PLANNED; a packed-but-unbatched unit shows up in packedUnits", async () => {
    const { tenantId, job, user } = await fixture();
    const actor = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);

    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unit1 = await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "01" } });
    const unit2 = await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "02" } });
    const pkg = await owner.package.create({
      data: { jobId: job.id, packageNo: "PKG-1", createdBy: user.id },
    });
    await owner.unit.update({ where: { id: unit1.id }, data: { packageId: pkg.id } });
    await owner.unit.update({ where: { id: unit2.id }, data: { packageId: pkg.id } });

    const batch = await owner.dispatchBatch.create({
      data: { jobId: job.id, seq: 1, plannedDate: new Date("2026-09-10") },
    });
    await owner.dispatchBatchUnit.create({ data: { dispatchBatchId: batch.id, unitId: unit1.id } });

    const panel = await loadDispatchPanel(actor, job.id);
    expect(panel?.batches).toHaveLength(1);
    expect(panel?.batches[0]).toMatchObject({ seq: 1, status: "PLANNED" });
    expect(panel?.batches[0].units.map((u) => u.serialNo)).toEqual(["01"]);
    expect(panel?.packedUnits.map((u) => u.serialNo)).toEqual(["02"]);
  });

  it("a RELEASED batch (releaseApprovedAt set) reports status RELEASED", async () => {
    const { tenantId, job, user } = await fixture();
    const actor = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const batch = await owner.dispatchBatch.create({
      data: {
        jobId: job.id,
        seq: 1,
        plannedDate: new Date("2026-09-10"),
        releaseApprovedBy: user.id,
        releaseApprovedAt: new Date(),
        vehicleNo: "MH-01-AB-1234",
      },
    });
    const panel = await loadDispatchPanel(actor, job.id);
    expect(panel?.batches[0]).toMatchObject({ id: batch.id, status: "RELEASED", vehicleNo: "MH-01-AB-1234" });
  });

  it("cross-tenant: refuses another tenant's job (surfaces as null, matching packing.read.ts's convention)", async () => {
    const { tenantId, user } = await fixture();
    const victim = await fixture();
    const attacker = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const panel = await loadDispatchPanel(attacker, victim.job.id);
    expect(panel).toBeNull();
  });
});
