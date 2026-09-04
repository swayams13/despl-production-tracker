import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * S6 — packing.service.ts had no test file at all. Covers the role gate
 * added to createPackage/assignUnitToPackage (dispatch.service.test.ts
 * already covers cross-tenant/cross-job refusals for these two, driven
 * through this service's exports).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("packing.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createPackage, assignUnitToPackage } = await import("./packing.service");
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

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  async function fixture() {
    const org = await owner.organization.create({
      data: { code: `TEST-PACKING-${Date.now()}-${Math.random()}`, name: "packing test" },
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
        publicId: `pub-packing-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-PACKING-${Date.now()}-${Math.random()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unit = await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "01" } });
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `ph-${Date.now()}-${Math.random()}@test.local`,
        username: `ph-${Date.now()}-${Math.random()}`,
        passwordHash: "x",
        name: "Test PH",
        themePreference: "SYSTEM",
      },
    });
    return { tenantId, job, unit, user };
  }

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

  it("createPackage + assignUnitToPackage succeed for a Production Head", async () => {
    const { tenantId, job, unit, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-1" });
    const updated = await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });
    expect(updated.packageId).toBe(pkg.id);
  });

  it("createPackage refuses a non-Production-Head, non-Admin caller (FORBIDDEN)", async () => {
    const { tenantId, job, user } = await fixture();
    const supervisor = actorBase(tenantId, user.id, [ROLES.SUPERVISOR]);
    await expectCode(createPackage(supervisor, { jobId: job.id, packageNo: "PKG-1" }), ERROR_CODES.FORBIDDEN);
  });

  it("assignUnitToPackage refuses a non-Production-Head, non-Admin caller (FORBIDDEN)", async () => {
    const { tenantId, job, unit, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const supervisor = actorBase(tenantId, user.id, [ROLES.SUPERVISOR]);
    const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-2" });
    await expectCode(
      assignUnitToPackage(supervisor, { packageId: pkg.id, unitId: unit.id }),
      ERROR_CODES.FORBIDDEN,
    );
  });
});
