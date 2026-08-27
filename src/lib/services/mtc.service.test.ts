import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * MaterialIdentification / recordMtc (B8, Phase 4) — DB-gated only, same
 * shape as procurement.service.test.ts's sibling (a role gate + a
 * tenant-anchored create, no pure logic worth isolating). Covers both
 * anchor paths: the pre-existing `bomItemId`-only path (regression) and the
 * new `componentId` path (new cross-tenant coverage, per task-6-brief.md),
 * plus `heatTrace`/`componentHeats` (bom.read.ts) against a fixture with one
 * heat number recorded across two components.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("mtc.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { recordMtc } = await import("./mtc.service");
  const { heatTrace, componentHeats } = await import("./bom.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.materialIdentification.deleteMany({ where: { bomItem: { equipment: { job: { tenantId } } } } });
    await owner.component.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.bomItem.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.equipment.deleteMany({ where: { job: { tenantId } } });
    await owner.job.deleteMany({ where: { tenantId } });
    await owner.processTemplateVersion.deleteMany({ where: { template: { tenantId } } });
    await owner.processTemplate.deleteMany({ where: { tenantId } });
    await owner.productFamily.deleteMany({ where: { tenantId } });
    await owner.componentTypeRef.deleteMany({ where: { tenantId } });
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
    const org = await owner.organization.create({ data: { code: `TEST-MTC-${Date.now()}`, name: "mtc test" } });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-mtc-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-MTC-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver", blockNo: 1 } });
    const bomItem = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 1, partName: "Shell Course 1", sourceQty: "1" },
    });
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "SHELL", name: "Shell" } });
    const componentA = await owner.component.create({
      data: { equipmentId: equipment.id, bomItemId: bomItem.id, tag: "SR01-SHELL", componentTypeId: componentType.id },
    });
    const componentB = await owner.component.create({
      data: { equipmentId: equipment.id, bomItemId: bomItem.id, tag: "SR02-SHELL", componentTypeId: componentType.id },
    });
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `qc-${Date.now()}@test.local`,
        username: `qc-${Date.now()}`,
        passwordHash: "x",
        name: "Test QC",
        themePreference: "SYSTEM",
      },
    });
    return { tenantId, job, equipment, bomItem, componentA, componentB, user };
  }

  function actorBase(tenantId: number, userId: number): Actor {
    return { userId, tenantId, clientId: null, name: "Test", email: "t@x", roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  it("bomItemId-only path (legacy) still works unchanged", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const qc: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.QC] };
    const record = await recordMtc(qc, { bomItemId: bomItem.id, heatNumber: "H-100", pmiResult: "ACCEPT" });
    expect(record.bomItemId).toBe(bomItem.id);
    expect(record.componentId).toBeNull();
  });

  it("componentId path anchors correctly and stores qtyIssued", async () => {
    const { tenantId, bomItem, componentA, user } = await fixture();
    const qc: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.QC] };
    const record = await recordMtc(qc, {
      bomItemId: bomItem.id,
      componentId: componentA.id,
      heatNumber: "H-200",
      pmiResult: "ACCEPT",
      qtyIssued: 12.5,
    });
    expect(record.componentId).toBe(componentA.id);
    expect(record.qtyIssued?.toString()).toBe("12.5");
  });

  it("cross-tenant: another tenant's actor cannot reach this component by id (NOT_FOUND) — new coverage for the componentId path", async () => {
    const { bomItem, componentA } = await fixture();
    const otherOrg = await owner.organization.create({ data: { code: `TEST-MTC-XT-${Date.now()}`, name: "Other tenant" } });
    createdOrgIds.push(otherOrg.id);
    const otherUser = await owner.user.create({
      data: {
        tenantId: otherOrg.id,
        email: `intruder-${Date.now()}@test.local`,
        username: `intruder-${Date.now()}`,
        passwordHash: "x",
        name: "Intruder",
        themePreference: "SYSTEM",
      },
    });
    const intruder: Actor = { ...actorBase(otherOrg.id, otherUser.id), roles: [ROLES.QC] };
    await expectCode(
      recordMtc(intruder, { bomItemId: bomItem.id, componentId: componentA.id, heatNumber: "H-300", pmiResult: "ACCEPT" }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("cross-tenant: a same-tenant componentId cannot legitimize a bomItemId from a different tenant (NOT_FOUND) — task review round 2", async () => {
    const { componentA } = await fixture();
    const otherFixture = await fixture();
    const attacker: Actor = { ...actorBase(otherFixture.tenantId, otherFixture.user.id), roles: [ROLES.QC] };
    // attacker's own componentId (their tenant) + victim's bomItemId (a different tenant, guessed/enumerated).
    await expectCode(
      recordMtc(attacker, {
        bomItemId: componentA.bomItemId ?? -1,
        componentId: otherFixture.componentA.id,
        heatNumber: "H-FORGED",
        pmiResult: "ACCEPT",
      }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("heatTrace / componentHeats: one heat recorded against two components traces forward and back", async () => {
    const { tenantId, bomItem, componentA, componentB, user } = await fixture();
    const qc: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.QC] };
    await recordMtc(qc, { bomItemId: bomItem.id, componentId: componentA.id, heatNumber: "H-SHARED", pmiResult: "ACCEPT" });
    await recordMtc(qc, { bomItemId: bomItem.id, componentId: componentB.id, heatNumber: "H-SHARED", pmiResult: "ACCEPT" });

    const forward = await heatTrace(qc, "H-SHARED");
    expect(forward.map((r) => r.componentId).sort()).toEqual([componentA.id, componentB.id].sort());

    const backA = await componentHeats(qc, componentA.id);
    expect(backA.map((r) => r.heatNumber)).toEqual(["H-SHARED"]);
    const backB = await componentHeats(qc, componentB.id);
    expect(backB.map((r) => r.heatNumber)).toEqual(["H-SHARED"]);
  });
});
