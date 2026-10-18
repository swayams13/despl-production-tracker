import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES } from "@/lib/shared/errors";
import type { WorkOrg } from "./work.test-util";

/**
 * Pilot friction (18 Oct 2026): issuing material to a part is that part's Receipt, so the issue
 * writes the RECEIPT operation (same transaction), and cutting no longer needs an override for it.
 * MTC Verification is a check, not a fact: never derived. DB-gated.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Receipt derived from a stock issue (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { makeWorkOrg } = await import("./work.test-util");
  const { issueStock, returnStock } = await import("./stock.service");
  const { issueAndPickHeat } = await import("./heat.service");
  const { recordWork } = await import("./work.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  let stores: Actor;
  let head: Actor;
  let sup: Actor;
  let bStores: Actor;
  const prior = process.env.LEAN_FLOOR;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "RCA");
    b = await makeWorkOrg(owner, "RCB");
    stores = await o.user("stores", ["STORES"]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    bStores = await b.user("bstores", ["STORES"]);
  });
  beforeEach(() => {
    process.env.LEAN_FLOOR = "on";
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.LEAN_FLOOR;
    else process.env.LEAN_FLOOR = prior;
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  /** A unit with an assembly sequence and a non-pressure bracket: Receipt, MTC Verification, Cutting. */
  async function fixture(receiptQc = false, org: WorkOrg = o) {
    const j = await org.job({
      steps: [{ seq: 1 }],
      components: [{ tag: "BRKT", ops: [{ code: "RECEIPT", requiresQc: receiptQc }, { code: "MTC_VERIFICATION", requiresQc: false }, { code: "CUTTING", requiresQc: false }] }],
    });
    const item = await owner.bomItem.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, itemNo: 1, partName: "PLATE", sourceQty: "1", qtyPer: 1 } });
    const lot = await owner.stockLot.create({ data: { jobId: j.job.id, bomItemId: item.id, heatNumber: "H-1", location: "Y1", qty: "10" } });
    return { j, item, lot, comp: j.components.get("BRKT:0")! };
  }
  const opRow = (id: number) => owner.componentOperation.findUniqueOrThrow({ where: { id } });
  const derivedAudits = (opId: number) =>
    owner.auditLog.count({ where: { tenantId: o.tenantId, entityType: "ComponentOperation", entityId: String(opId), action: "work.receipt.derived" } });
  const issue = (actor: Actor, f: Awaited<ReturnType<typeof fixture>>, qty = 1) =>
    issueStock(actor, { stockLotId: f.lot.id, qty, componentId: f.comp });

  it("an issue to a part completes its Receipt (no QC needed): server clock, the Stores user, audited as derived; MTC Verification untouched", async () => {
    const f = await fixture();
    await issue(stores, f);
    const receipt = await opRow(f.j.op("BRKT", "RECEIPT"));
    expect(receipt).toMatchObject({ status: "COMPLETE", submittedBy: stores.userId });
    expect(receipt.startedAt).not.toBeNull();
    expect(receipt.finishedAt).not.toBeNull();
    expect(receipt.reportedFinishAt).toBeNull();
    expect(await derivedAudits(receipt.id)).toBe(1);
    expect((await opRow(f.j.op("BRKT", "MTC_VERIFICATION"))).status).toBe("NOT_STARTED");
    expect((await opRow(f.j.op("BRKT", "CUTTING"))).status).toBe("NOT_STARTED");
  });

  it("a Receipt that needs QC goes to SUBMITTED, never straight to COMPLETE (invariant 3), and still counts as done for the order", async () => {
    const f = await fixture(true);
    await issue(stores, f);
    const receipt = await opRow(f.j.op("BRKT", "RECEIPT"));
    expect(receipt).toMatchObject({ status: "SUBMITTED", submittedBy: stores.userId, finishedAt: null, verifiedBy: null });
  });

  it("cutting then asks for an override for MTC Verification only, never for Receipt (option a: the check stays a real tick)", async () => {
    const f = await fixture();
    await issue(stores, f);
    const cutting = f.j.op("BRKT", "CUTTING");
    const refused = await recordWork(sup, { jobId: f.j.job.id, action: "START", items: [{ kind: "COMPONENT_OP", id: cutting }] });
    const r = refused.refused.find((x) => x.id === cutting);
    expect(r?.code).toBe(ERROR_CODES.SEQUENCE_OVERRIDE_REQUIRED);
    expect(r?.meta.open).toEqual([expect.objectContaining({ id: f.j.op("BRKT", "MTC_VERIFICATION") })]);

    // Once MTC Verification is ticked, cutting starts with no override.
    await owner.componentOperation.update({ where: { id: f.j.op("BRKT", "MTC_VERIFICATION") }, data: { status: "COMPLETE" } });
    const ok = await recordWork(sup, { jobId: f.j.job.id, action: "START", items: [{ kind: "COMPONENT_OP", id: cutting }] });
    expect(ok.applied).toMatchObject([{ id: cutting, overridden: false }]);
  });

  it("without the lean floor the issue leaves the route alone", async () => {
    delete process.env.LEAN_FLOOR;
    const f = await fixture();
    await issue(stores, f);
    expect((await opRow(f.j.op("BRKT", "RECEIPT"))).status).toBe("NOT_STARTED");
  });

  describe("does nothing when", () => {
    it("the Receipt is already complete: not rewritten, no second audit row, a second issue changes nothing", async () => {
      const f = await fixture();
      await issue(stores, f);
      const first = await opRow(f.j.op("BRKT", "RECEIPT"));
      await issue(stores, f, 2);
      const again = await opRow(f.j.op("BRKT", "RECEIPT"));
      expect(again.finishedAt?.getTime()).toBe(first.finishedAt?.getTime());
      expect(await derivedAudits(first.id)).toBe(1);
    });

    it("the Receipt was already submitted by a person", async () => {
      const f = await fixture(true);
      const id = f.j.op("BRKT", "RECEIPT");
      await owner.componentOperation.update({ where: { id }, data: { status: "SUBMITTED", submittedBy: head.userId } });
      await issue(stores, f);
      expect(await opRow(id)).toMatchObject({ status: "SUBMITTED", submittedBy: head.userId });
      expect(await derivedAudits(id)).toBe(0);
    });

    it("the part has no Receipt step on its route", async () => {
      const j = await o.job({ steps: [{ seq: 1 }], components: [{ tag: "PIPE", ops: [{ code: "CUTTING", requiresQc: false }] }] });
      const item = await owner.bomItem.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, itemNo: 1, partName: "P", sourceQty: "1", qtyPer: 1 } });
      const lot = await owner.stockLot.create({ data: { jobId: j.job.id, bomItemId: item.id, heatNumber: "H-2", location: "Y1", qty: "5" } });
      await issueStock(stores, { stockLotId: lot.id, qty: 1, componentId: j.components.get("PIPE:0")! });
      expect((await opRow(j.op("PIPE", "CUTTING"))).status).toBe("NOT_STARTED");
    });

    it("a rejection NCR is open on the Receipt", async () => {
      const f = await fixture();
      const id = f.j.op("BRKT", "RECEIPT");
      const category = await owner.delayCategoryRef.findFirstOrThrow({ where: { tenantId: o.tenantId } });
      const rejection = await owner.componentOperationRejection.create({
        data: { jobId: f.j.job.id, componentOperationId: id, categoryId: category.id, rejectedBy: head.userId },
      });
      await owner.ncr.create({ data: { jobId: f.j.job.id, componentOperationRejectionId: rejection.id } });
      await issue(stores, f);
      expect((await opRow(id)).status).toBe("NOT_STARTED");
    });

    it("it is a return, not an issue", async () => {
      const f = await fixture();
      await owner.stockTxn.create({ data: { stockLotId: f.lot.id, type: "ISSUE", qty: "2", by: head.userId, componentId: f.comp, jobId: f.j.job.id } });
      await returnStock(stores, { stockLotId: f.lot.id, qty: 1, componentId: f.comp });
      expect((await opRow(f.j.op("BRKT", "RECEIPT"))).status).toBe("NOT_STARTED");
    });

    it("the issue names no part", async () => {
      const f = await fixture();
      await issueStock(stores, { stockLotId: f.lot.id, qty: 1 });
      expect((await opRow(f.j.op("BRKT", "RECEIPT"))).status).toBe("NOT_STARTED");
    });
  });

  it("only the part issued to is touched", async () => {
    const j = await o.job({
      steps: [{ seq: 1 }],
      components: [
        { tag: "A", ops: [{ code: "RECEIPT", requiresQc: false }] },
        { tag: "B", ops: [{ code: "RECEIPT", requiresQc: false }] },
      ],
    });
    const item = await owner.bomItem.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, itemNo: 1, partName: "P", sourceQty: "1", qtyPer: 1 } });
    const lot = await owner.stockLot.create({ data: { jobId: j.job.id, bomItemId: item.id, heatNumber: "H-3", location: "Y1", qty: "5" } });
    await issueStock(stores, { stockLotId: lot.id, qty: 1, componentId: j.components.get("A:0")! });
    expect((await opRow(j.op("A", "RECEIPT"))).status).toBe("COMPLETE");
    expect((await opRow(j.op("B", "RECEIPT"))).status).toBe("NOT_STARTED");
  });

  it("a refused issue (over-issue) leaves the Receipt alone: the write and the issue are one transaction", async () => {
    const f = await fixture();
    await expect(issue(stores, f, 999)).rejects.toMatchObject({ code: ERROR_CODES.INSUFFICIENT_STOCK });
    expect((await opRow(f.j.op("BRKT", "RECEIPT"))).status).toBe("NOT_STARTED");
  });

  it("another tenant cannot issue to this part, and nothing is derived", async () => {
    const f = await fixture();
    await expect(issueStock(bStores, { stockLotId: f.lot.id, qty: 1, componentId: f.comp })).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    expect((await opRow(f.j.op("BRKT", "RECEIPT"))).status).toBe("NOT_STARTED");
  });

  it("issue-and-pick-heat (Production Head) derives the Receipt the same way", async () => {
    const j = await o.job({ steps: [{ seq: 1 }], components: [{ tag: "SH", pressure: true, ops: [{ code: "RECEIPT", requiresQc: false }, { code: "CUTTING", requiresQc: false }] }] });
    const item = await owner.bomItem.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, itemNo: 1, partName: "SH", sourceQty: "1", qtyPer: 1 } });
    const comp = j.components.get("SH:0")!;
    await owner.component.update({ where: { id: comp }, data: { bomItemId: item.id } });
    const lot = await owner.stockLot.create({ data: { jobId: j.job.id, bomItemId: item.id, heatNumber: "H-9", location: "Y1", qty: "3" } });
    await issueAndPickHeat(head, { componentId: comp, stockLotId: lot.id, qty: 1 });
    expect(await opRow(j.op("SH", "RECEIPT"))).toMatchObject({ status: "COMPLETE", submittedBy: head.userId });
  });
});
