import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * StockLot/StockTxn (B6, Phase 4) — DB-gated only, same shape as
 * `procurement.service.test.ts`: a role gate + a tenant-anchored create, no
 * pure logic worth isolating on its own. The shortage-calc table-driven test
 * exercises `bom.read.ts`'s `requiredQty`/`availableQty`/`shortage` against
 * a real multi-unit equipment with a BOM tree (parent/child qtyPer), which is
 * exactly what Dispatch 2's `explodeBomItem` was built for.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("stock.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { receiveStock, issueStock, returnStock, scrapStock } = await import("./stock.service");
  const { requiredQty, availableQty, shortage } = await import("./bom.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.stockTxn.deleteMany({ where: { stockLot: { bomItem: { equipment: { job: { tenantId } } } } } });
    await owner.stockLot.deleteMany({ where: { bomItem: { equipment: { job: { tenantId } } } } });
    await owner.procurementEvent.deleteMany({ where: { bomItem: { equipment: { job: { tenantId } } } } });
    await owner.component.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.bomItem.deleteMany({ where: { equipment: { job: { tenantId } } } });
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

  async function fixture(unitCount = 1) {
    const org = await owner.organization.create({ data: { code: `TEST-STOCK-${Date.now()}-${Math.random()}`, name: "stock test" } });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-stock-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-STOCK-${Date.now()}-${Math.random()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver", blockNo: 1 } });
    for (let i = 0; i < unitCount; i++) {
      await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: `SR${i + 1}` } });
    }
    const bomItem = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 1, partName: "Shell Course 1", sourceQty: "2 NOS.", qtyPer: 2, uom: "NOS." },
    });
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
    return { tenantId, job, equipment, bomItem, user };
  }

  function actorBase(tenantId: number, userId: number): Actor {
    return { userId, tenantId, clientId: null, name: "Test", email: "t@x", roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  it("refuses a SUPERVISOR caller on all four service functions (RBAC deny-by-default)", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const supervisor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.SUPERVISOR] };
    await expectCode(receiveStock(supervisor, { bomItemId: bomItem.id, location: "Yard A", qty: 10 }), ERROR_CODES.FORBIDDEN);

    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 10 });
    await expectCode(issueStock(supervisor, { stockLotId: lot.id, qty: 1 }), ERROR_CODES.FORBIDDEN);
    await expectCode(returnStock(supervisor, { stockLotId: lot.id, qty: 1 }), ERROR_CODES.FORBIDDEN);
    await expectCode(scrapStock(supervisor, { stockLotId: lot.id, qty: 1 }), ERROR_CODES.FORBIDDEN);
  });

  it("receive then issue reduces available", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 10, heatNumber: "H100" });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(10);

    await issueStock(ph, { stockLotId: lot.id, qty: 4 });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(6);
  });

  it("issuing exactly the available amount succeeds; one more fails (exact boundary)", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 5 });

    // Issue exactly the available amount — succeeds, leaves 0.
    await issueStock(ph, { stockLotId: lot.id, qty: 5 });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(0);

    // A second lot to isolate the "one more than available" boundary cleanly.
    const lot2 = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 5 });
    await expectCode(issueStock(ph, { stockLotId: lot2.id, qty: 6 }), ERROR_CODES.INSUFFICIENT_STOCK);
    // Lot2's own available is unaffected by the refused attempt.
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(5);
  });

  it("scrap moves the number down the same way issue does, and is refused past the boundary", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 8 });
    await scrapStock(ph, { stockLotId: lot.id, qty: 3, note: "Rusted" });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(5);
    await expectCode(scrapStock(ph, { stockLotId: lot.id, qty: 6 }), ERROR_CODES.INSUFFICIENT_STOCK);
  });

  it("return moves the number back up, with no over-issue-style guard", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 10 });
    await issueStock(ph, { stockLotId: lot.id, qty: 7 });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(3);

    await returnStock(ph, { stockLotId: lot.id, qty: 4 });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(7);
  });

  it("cross-tenant: another tenant's actor cannot reach this bom item or lot", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const { tenantId: otherTenantId, user: otherUser } = await fixture();
    const intruder: Actor = { ...actorBase(otherTenantId, otherUser.id), roles: [ROLES.PRODUCTION_HEAD] };
    await expectCode(
      receiveStock(intruder, { bomItemId: bomItem.id, location: "Yard A", qty: 1 }),
      ERROR_CODES.NOT_FOUND,
    );

    // A lot that legitimately exists in the FIRST tenant is unreachable from the second.
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 5 });
    await expectCode(issueStock(intruder, { stockLotId: lot.id, qty: 1 }), ERROR_CODES.NOT_FOUND);
    await expectCode(returnStock(intruder, { stockLotId: lot.id, qty: 1 }), ERROR_CODES.NOT_FOUND);
    await expectCode(scrapStock(intruder, { stockLotId: lot.id, qty: 1 }), ERROR_CODES.NOT_FOUND);
  });

  it("SEAM: a BomItem with zero StockLot/StockTxn rows reports null, never 0", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    expect(await availableQty(ph, bomItem.id)).toBeNull();
    expect(await shortage(ph, bomItem.id)).toBeNull();
  });

  it("shortage calc against explodeBomItem's output for a real multi-unit equipment (table-driven)", async () => {
    // qtyPer 2, 3 units → required = 6 (B3's explosion). Table of
    // (received, issued/scrapped, returned) → expected shortage.
    const cases: { received: number; issued: number; returned: number; expectedShortage: number }[] = [
      { received: 6, issued: 0, returned: 0, expectedShortage: 0 }, // exactly covers required
      { received: 4, issued: 0, returned: 0, expectedShortage: 2 }, // short by 2
      { received: 10, issued: 0, returned: 0, expectedShortage: -4 }, // surplus of 4 (negative, not clamped here)
      { received: 10, issued: 3, returned: 1, expectedShortage: -2 }, // 10 - 3 + 1 = 8 available, 6 required → surplus 2
    ];
    for (const c of cases) {
      const { tenantId, bomItem, user } = await fixture(3);
      const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
      expect((await requiredQty(ph, bomItem.id)).toNumber()).toBe(6);

      const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: c.received });
      if (c.issued > 0) await issueStock(ph, { stockLotId: lot.id, qty: c.issued });
      if (c.returned > 0) await returnStock(ph, { stockLotId: lot.id, qty: c.returned });

      const result = await shortage(ph, bomItem.id);
      expect(result?.toNumber()).toBe(c.expectedShortage);
    }
  });

  it("SEAM (again, via shortage on a fresh multi-unit fixture): required qty is real but no stock activity → shortage null, not the full required amount", async () => {
    const { tenantId, bomItem, user } = await fixture(3);
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    expect((await requiredQty(ph, bomItem.id)).toNumber()).toBe(6);
    expect(await shortage(ph, bomItem.id)).toBeNull();
  });
});
