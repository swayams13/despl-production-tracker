import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * S8 — DB-backed coverage for `loadPackingPanel`: units grouped by their
 * Package across the whole job (not scoped to one equipment, unlike
 * bom.read.ts/assembly.read.ts — Package.jobId is a direct FK), and the
 * unpacked-units list that seeds the assign-unit picker.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("packing.read — loadPackingPanel (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadPackingPanel } = await import("./packing.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
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
      data: { code: `TEST-PACKREAD-${Date.now()}-${Math.random()}`, name: "packing.read test" },
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
        publicId: `pub-packread-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-PACKREAD-${Date.now()}-${Math.random()}`,
      },
    });
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `packread-${Date.now()}-${Math.random()}@test.local`,
        username: `packread-${Date.now()}-${Math.random()}`,
        passwordHash: "x",
        name: "Test PH",
        themePreference: "SYSTEM",
      },
    });
    return { tenantId, job, user };
  }

  it("a job with no equipment/units returns empty packages and unpackedUnits, not null", async () => {
    const { tenantId, job, user } = await fixture();
    const actor = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const panel = await loadPackingPanel(actor, job.id);
    expect(panel).toEqual({ packages: [], unpackedUnits: [] });
  });

  it("groups units by package across two different equipment on the same job; unpacked units listed separately", async () => {
    const { tenantId, job, user } = await fixture();
    const actor = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);

    const equipmentA = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver A" } });
    const equipmentB = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver B" } });
    const unitA1 = await owner.unit.create({ data: { equipmentId: equipmentA.id, serialNo: "A-01" } });
    const unitA2 = await owner.unit.create({ data: { equipmentId: equipmentA.id, serialNo: "A-02" } });
    const unitB1 = await owner.unit.create({ data: { equipmentId: equipmentB.id, serialNo: "B-01" } });

    const pkg = await owner.package.create({
      data: {
        jobId: job.id,
        packageNo: "PKG-1",
        weightKg: 120.5,
        lengthMm: 2000,
        widthMm: 800,
        heightMm: 800,
        preservationNotes: "VCI wrap",
        createdBy: user.id,
      },
    });
    // A package can hold units from different equipment on the same job —
    // that's exactly why Package has no equipmentId of its own.
    await owner.unit.update({ where: { id: unitA1.id }, data: { packageId: pkg.id } });
    await owner.unit.update({ where: { id: unitB1.id }, data: { packageId: pkg.id } });

    const panel = await loadPackingPanel(actor, job.id);
    expect(panel?.packages).toHaveLength(1);
    expect(panel?.packages[0]).toMatchObject({
      packageNo: "PKG-1",
      weightKg: 120.5,
      lengthMm: 2000,
      preservationNotes: "VCI wrap",
    });
    expect(panel?.packages[0].units.map((u) => u.serialNo).sort()).toEqual(["A-01", "B-01"]);
    expect(panel?.unpackedUnits.map((u) => u.serialNo)).toEqual([unitA2.serialNo]);
  });

  it("cross-tenant: refuses another tenant's job (client-scope violation surfaces as null, matching bom.read.ts's convention)", async () => {
    const { tenantId, user } = await fixture();
    const victim = await fixture();
    const attacker = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const panel = await loadPackingPanel(attacker, victim.job.id);
    expect(panel).toBeNull();
  });
});
