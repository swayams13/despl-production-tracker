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
      await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: `SR${i + 1}` } });
    }
    const bomItem = await owner.bomItem.create({
      data: { jobId: job.id, equipmentId: equipment.id, itemNo: 1, partName: "Shell Course 1", sourceQty: "2 NOS.", qtyPer: 2, uom: "NOS." },
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

  it("receive then issue does NOT reduce shortage-relevant available (fix wave, Critical #1) — issuing into the product is consumption as intended, not loss", async () => {
    const { tenantId, job, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 10, heatNumber: "H100" });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(10);
    // H1: receiveStock populates jobId on the created StockLot.
    expect(lot.jobId).toBe(job.id);

    const txn = await issueStock(ph, { stockLotId: lot.id, qty: 4 });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(10);
    // H1: createStockTxn populates jobId from the lot's own jobId.
    expect(txn.jobId).toBe(job.id);
  });

  it("issuing exactly the lot's physical available amount succeeds; one more fails (exact boundary) — the lot-level over-issue guard is a separate, unaffected physical-ledger check", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 5 });

    // Issue exactly the lot's physical available amount — succeeds. The
    // shortage-relevant availableQty is unaffected by ISSUE (fix wave).
    await issueStock(ph, { stockLotId: lot.id, qty: 5 });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(5);

    // A second lot to isolate the "one more than physically available" boundary cleanly.
    const lot2 = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 5 });
    await expectCode(issueStock(ph, { stockLotId: lot2.id, qty: 6 }), ERROR_CODES.INSUFFICIENT_STOCK);
    // Both lots' qty still count toward shortage-relevant available (no SCRAP recorded).
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(10);
  });

  /**
   * S21: genuine two-transaction race (same shape as client-snapshot.
   * service.test.ts's verifySnapshot race), not a simulated one. A lot with
   * exactly enough for ONE full issue, hit by two concurrent issueStock
   * calls for the full amount each. Without loadLotForMutation's `FOR
   * UPDATE` lock, both transactions can read the same "available: 8"
   * snapshot before either commits and both pass the over-issue guard,
   * over-issuing the lot. WITH the lock, the second transaction's read is
   * forced to happen strictly after the first's commit, so the outcome is
   * deterministic: exactly one succeeds, the other sees the reduced
   * available and is refused INSUFFICIENT_STOCK — never both succeeding.
   */
  it("issueStock serializes concurrent issues against the same lot — never both succeed and over-issue it", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 8 });

    const results = await Promise.allSettled([
      issueStock(ph, { stockLotId: lot.id, qty: 8 }),
      issueStock(ph, { stockLotId: lot.id, qty: 8 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loserCode = (rejected[0] as PromiseRejectedResult & { reason: { code: string } }).reason.code;
    expect(loserCode).toBe(ERROR_CODES.INSUFFICIENT_STOCK);

    // Exactly one ISSUE txn landed — the lot was not over-issued.
    const issues = await owner.stockTxn.findMany({ where: { stockLotId: lot.id, type: "ISSUE" } });
    expect(issues).toHaveLength(1);
  });

  it("scrap is the only txn type that moves shortage-relevant available down, and is refused past the lot's physical boundary", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 8 });
    await scrapStock(ph, { stockLotId: lot.id, qty: 3, note: "Rusted" });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(5);
    await expectCode(scrapStock(ph, { stockLotId: lot.id, qty: 6 }), ERROR_CODES.INSUFFICIENT_STOCK);
  });

  it("return does not move shortage-relevant available either (fix wave) — only SCRAP does; at the physical lot level, a return still restores headroom for a further issue", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 10 });
    await issueStock(ph, { stockLotId: lot.id, qty: 7 });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(10);

    await returnStock(ph, { stockLotId: lot.id, qty: 4 });
    expect((await availableQty(ph, bomItem.id))?.toNumber()).toBe(10);

    // Physical lot-level effect of the return (unaffected by this fix): issued
    // 7, returned 4 → physical available is 7 (10 - 7 + 4); a further issue
    // up to 7 succeeds, one more fails.
    await issueStock(ph, { stockLotId: lot.id, qty: 7 });
    await expectCode(issueStock(ph, { stockLotId: lot.id, qty: 1 }), ERROR_CODES.INSUFFICIENT_STOCK);
  });

  it("createStockTxn refuses a componentId from a different job than the stockLotId's own job", async () => {
    // H1: Job A's StockLot + Job B's Component in the SAME tenant.
    const { tenantId, job, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: 10 });

    const client = await owner.client.findFirstOrThrow({ where: { tenantId } });
    const jobB = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-stock-b-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: job.familyId,
        templateVersionId: job.templateVersionId,
        jobNumber: `DE-STOCK-B-${Date.now()}-${Math.random()}`,
      },
    });
    const equipmentB = await owner.equipment.create({ data: { jobId: jobB.id, name: "Air Receiver B", blockNo: 1 } });
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "SHELL", name: "Shell" } });
    const componentB = await owner.component.create({
      data: { jobId: jobB.id, equipmentId: equipmentB.id, tag: "SHELL-1", componentTypeId: componentType.id },
    });

    await expectCode(
      issueStock(ph, { stockLotId: lot.id, qty: 1, componentId: componentB.id }),
      ERROR_CODES.VALIDATION_FAILED,
    );

    // Control: a componentId genuinely in the lot's own job (Job A) succeeds.
    const equipmentA = await owner.equipment.findFirstOrThrow({ where: { jobId: job.id } });
    const componentA = await owner.component.create({
      data: { jobId: job.id, equipmentId: equipmentA.id, tag: "SHELL-1", componentTypeId: componentType.id },
    });
    const txn = await issueStock(ph, { stockLotId: lot.id, qty: 1, componentId: componentA.id });
    expect(txn.componentId).toBe(componentA.id);
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

  it("cross-tenant: requiredQty/availableQty/shortage all refuse a bomItemId belonging to another tenant", async () => {
    const { bomItem } = await fixture();
    const { tenantId: otherTenantId, user: otherUser } = await fixture();
    const intruder: Actor = { ...actorBase(otherTenantId, otherUser.id), roles: [ROLES.PRODUCTION_HEAD] };
    await expectCode(requiredQty(intruder, bomItem.id), ERROR_CODES.NOT_FOUND);
    await expectCode(availableQty(intruder, bomItem.id), ERROR_CODES.NOT_FOUND);
    await expectCode(shortage(intruder, bomItem.id), ERROR_CODES.NOT_FOUND);
  });

  it("SEAM: a BomItem with zero StockLot/StockTxn rows reports null, never 0", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    expect(await availableQty(ph, bomItem.id)).toBeNull();
    expect(await shortage(ph, bomItem.id)).toBeNull();
  });

  it("shortage calc against explodeBomItem's output for a real multi-unit equipment (table-driven; fix wave, Critical #1: only SCRAP moves the number, ISSUE/RETURN don't)", async () => {
    // qtyPer 2, 3 units → required = 6 (B3's explosion). Table of
    // (received, issued, returned, scrapped) → expected shortage.
    const cases: { received: number; issued: number; returned: number; scrapped: number; expectedShortage: number }[] = [
      { received: 6, issued: 0, returned: 0, scrapped: 0, expectedShortage: 0 }, // exactly covers required
      { received: 4, issued: 0, returned: 0, scrapped: 0, expectedShortage: 2 }, // short by 2
      { received: 10, issued: 0, returned: 0, scrapped: 0, expectedShortage: -4 }, // surplus of 4 (negative, not clamped here)
      { received: 10, issued: 3, returned: 1, scrapped: 0, expectedShortage: -4 }, // ISSUE/RETURN don't move it — same surplus as the no-activity case above (the regression this fix wave exists for)
      { received: 10, issued: 0, returned: 0, scrapped: 2, expectedShortage: -2 }, // SCRAP is the only real deduction: 10 - 2 = 8 available, 6 required → surplus 2
    ];
    for (const c of cases) {
      const { tenantId, bomItem, user } = await fixture(3);
      const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
      expect((await requiredQty(ph, bomItem.id)).toNumber()).toBe(6);

      const lot = await receiveStock(ph, { bomItemId: bomItem.id, location: "Yard A", qty: c.received });
      if (c.issued > 0) await issueStock(ph, { stockLotId: lot.id, qty: c.issued });
      if (c.returned > 0) await returnStock(ph, { stockLotId: lot.id, qty: c.returned });
      if (c.scrapped > 0) await scrapStock(ph, { stockLotId: lot.id, qty: c.scrapped });

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
