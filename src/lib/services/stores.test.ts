import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { storesAccess } from "@/lib/shared/stores-access";
import type { WorkOrg } from "./work.test-util";

/**
 * Lean Core L2.14. The pure access table first; then, DB-gated, every Stores action
 * against every role (violations first), the one-time heat number on a lot, and the
 * database's own guard on stock_lots.
 */
describe("L2.14 Stores access table (pure)", () => {
  const cases: Array<[string, Record<string, boolean>]> = [
    ["STORES", { receive: true, issue: true, scrap: false, procurement: false, receiptEvent: true, identify: true, decidePmi: false, lotHeat: true }],
    ["PRODUCTION_HEAD", { receive: true, issue: true, scrap: true, procurement: true, receiptEvent: true, identify: true, decidePmi: false, lotHeat: true }],
    ["ADMIN", { receive: true, issue: true, scrap: true, procurement: true, receiptEvent: true, identify: true, decidePmi: false, lotHeat: true }],
    ["QC", { receive: false, issue: false, scrap: false, procurement: false, receiptEvent: false, identify: true, decidePmi: true, lotHeat: false }],
    ...["SUPERVISOR", "OPERATOR", "PLANNER", "ENGINEERING", "MANAGEMENT"].map((r): [string, Record<string, boolean>] => [
      r,
      { receive: false, issue: false, scrap: false, procurement: false, receiptEvent: false, identify: false, decidePmi: false, lotHeat: false },
    ]),
  ];
  it.each(cases)("%s", (role, expected) => expect({ ...storesAccess([role]) }).toEqual(expected));
  it("a user with two roles gets the union", () => {
    expect(storesAccess(["QC", "STORES"])).toMatchObject({ receive: true, decidePmi: true, scrap: false });
    expect(storesAccess([])).toMatchObject({ receive: false, identify: false });
  });
});

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L2.14 Stores actions (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { makeWorkOrg } = await import("./work.test-util");
  const { withTenant } = await import("@/lib/db");
  const { receiveStock, issueStock, returnStock, scrapStock, recordLotHeat } = await import("./stock.service");
  const { recordProcurementEvent } = await import("./procurement.service");
  const { recordMtc } = await import("./mtc.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  const actors = new Map<string, Actor>();
  let bStores: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "STA");
    b = await makeWorkOrg(owner, "STB");
    for (const r of ["STORES", "PRODUCTION_HEAD", "ADMIN", "QC", "SUPERVISOR", "OPERATOR", "PLANNER", "ENGINEERING", "MANAGEMENT"]) actors.set(r, await o.user(r.toLowerCase(), [r]));
    bStores = await b.user("bstores", ["STORES"]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  async function fixture(org: WorkOrg = o) {
    const j = await org.job({ components: [{ tag: "SH-1", pressure: true, ops: [{ code: "CUTTING" }] }] });
    const item = await owner.bomItem.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, itemNo: 1, partName: "PLATE", sourceQty: "1", qtyPer: 1 } });
    const lot = async (heat: string | null = null, qty = "10") =>
      owner.stockLot.create({ data: { jobId: j.job.id, bomItemId: item.id, heatNumber: heat, location: "Y1", qty } });
    return { j, item, lot, comp: j.components.get("SH-1:0")! };
  }

  type Action = "receive" | "issue" | "return" | "scrap" | "receipt" | "indent" | "po" | "identifyPending" | "identifyAccept" | "lotHeat";
  const ACTIONS: Action[] = ["receive", "issue", "return", "scrap", "receipt", "indent", "po", "identifyPending", "identifyAccept", "lotHeat"];
  /** Who may do what, written out by hand (not read from the module under test). */
  const ALLOWED: Record<Action, string[]> = {
    receive: ["STORES", "PRODUCTION_HEAD", "ADMIN"],
    issue: ["STORES", "PRODUCTION_HEAD", "ADMIN"],
    return: ["STORES", "PRODUCTION_HEAD", "ADMIN"],
    scrap: ["PRODUCTION_HEAD", "ADMIN"],
    receipt: ["STORES", "PRODUCTION_HEAD", "ADMIN"],
    indent: ["PRODUCTION_HEAD", "ADMIN"],
    po: ["PRODUCTION_HEAD", "ADMIN"],
    identifyPending: ["QC", "STORES", "PRODUCTION_HEAD", "ADMIN"],
    identifyAccept: ["QC"],
    lotHeat: ["STORES", "PRODUCTION_HEAD", "ADMIN"],
  };

  async function attempt(role: string, action: Action) {
    const a = actors.get(role)!;
    const f = await fixture();
    const lot = await f.lot(null, "10");
    switch (action) {
      case "receive": return receiveStock(a, { bomItemId: f.item.id, location: "Y2", qty: 3 });
      case "issue": return issueStock(a, { stockLotId: lot.id, qty: 1 });
      case "return":
        await owner.stockTxn.create({ data: { jobId: f.j.job.id, stockLotId: lot.id, type: "ISSUE", qty: "2", by: a.userId } }); // something is out to return
        return returnStock(a, { stockLotId: lot.id, qty: 1 });
      case "scrap": return scrapStock(a, { stockLotId: lot.id, qty: 1 });
      case "receipt": return recordProcurementEvent(a, { bomItemId: f.item.id, type: "RECEIPT", qty: 3 });
      case "indent": return recordProcurementEvent(a, { bomItemId: f.item.id, type: "INDENT_RAISED", refNo: "I1" });
      case "po": return recordProcurementEvent(a, { bomItemId: f.item.id, type: "PO_PLACED", refNo: "P1" });
      case "identifyPending": return recordMtc(a, { bomItemId: f.item.id, heatNumber: "H-1", mtcRef: "MTC-1", pmiResult: "PENDING" });
      case "identifyAccept": return recordMtc(a, { bomItemId: f.item.id, heatNumber: "H-1", pmiResult: "ACCEPT" });
      case "lotHeat": return recordLotHeat(a, { stockLotId: lot.id, heatNumber: "H-9" });
    }
  }

  for (const action of ACTIONS) {
    it(`${action}: only ${ALLOWED[action].join(", ")}`, async () => {
      for (const role of actors.keys()) {
        if (ALLOWED[action].includes(role)) await expect(attempt(role, action), `${role} may ${action}`).resolves.toBeTruthy();
        else await expect(attempt(role, action), `${role} may not ${action}`).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    });
  }

  it("never for a client user, and never across tenants", async () => {
    const f = await fixture();
    const lot = await f.lot(null);
    const stores = actors.get("STORES")!;
    await expect(receiveStock({ ...stores, clientId: o.tenantId }, { bomItemId: f.item.id, location: "Y", qty: 1 })).rejects.toBeTruthy();
    await expect(recordLotHeat({ ...stores, clientId: o.tenantId }, { stockLotId: lot.id, heatNumber: "H" })).rejects.toBeTruthy();
    await expect(recordLotHeat(bStores, { stockLotId: lot.id, heatNumber: "H" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(issueStock(bStores, { stockLotId: lot.id, qty: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await owner.stockLot.findUniqueOrThrow({ where: { id: lot.id } })).heatNumber).toBeNull();
  });

  it("a lot received without a heat number can be given one, once, audited, and then the floor can pick it", async () => {
    const { pickHeatNumber } = await import("./heat.service");
    const f = await fixture();
    const lot = await f.lot(null);
    const stores = actors.get("STORES")!;
    await expect(recordLotHeat(stores, { stockLotId: lot.id, heatNumber: "   " })).rejects.toBeTruthy();
    await expect(recordLotHeat(stores, { stockLotId: lot.id, heatNumber: "x".repeat(65) })).rejects.toBeTruthy();

    await owner.component.update({ where: { id: f.comp }, data: { bomItemId: f.item.id } });
    await expect(pickHeatNumber(actors.get("PRODUCTION_HEAD")!, { componentId: f.comp, stockLotId: lot.id })).rejects.toMatchObject({
      detail: { reason: expect.stringMatching(/Ask Stores/) },
    });

    expect(await recordLotHeat(stores, { stockLotId: lot.id, heatNumber: " H-7001 " })).toEqual({ stockLotId: lot.id, heatNumber: "H-7001" });
    expect((await owner.stockLot.findUniqueOrThrow({ where: { id: lot.id } })).heatNumber).toBe("H-7001");
    const audit = await owner.auditLog.findFirst({ where: { tenantId: o.tenantId, action: "stock.recordHeat", entityId: String(lot.id) } });
    expect(audit).toMatchObject({ actorId: stores.userId });
    expect(audit?.before).toEqual({ heatNumber: null });
    expect(audit?.after).toMatchObject({ heatNumber: "H-7001" });

    await expect(recordLotHeat(stores, { stockLotId: lot.id, heatNumber: "H-OTHER" })).rejects.toMatchObject({
      detail: { reason: expect.stringMatching(/already has heat number H-7001/) },
    });
    await expect(recordLotHeat(actors.get("PRODUCTION_HEAD")!, { stockLotId: lot.id, heatNumber: "H-7001" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(pickHeatNumber(actors.get("PRODUCTION_HEAD")!, { componentId: f.comp, stockLotId: lot.id })).resolves.toMatchObject({ heatNumber: "H-7001" });
  });

  it("only a first heat number may change on a lot: the app role and the table owner are both held to it", async () => {
    const f = await fixture();
    const lot = await f.lot(null);
    const app = (sql: () => Promise<unknown>) => withTenant(o.tenantId, () => sql());
    // the app role has no UPDATE on any other column
    await expect(withTenant(o.tenantId, (tx) => tx.$executeRaw`UPDATE stock_lots SET qty = 99 WHERE id = ${lot.id}`)).rejects.toThrow(/permission denied/i);
    await expect(withTenant(o.tenantId, (tx) => tx.$executeRaw`UPDATE stock_lots SET location = 'Z' WHERE id = ${lot.id}`)).rejects.toThrow(/permission denied/i);
    // NULL to a value is the one allowed change
    await app(() => withTenant(o.tenantId, (tx) => tx.$executeRaw`UPDATE stock_lots SET heat_number = 'H-1' WHERE id = ${lot.id}`));
    // after that, not even the heat number
    await expect(withTenant(o.tenantId, (tx) => tx.$executeRaw`UPDATE stock_lots SET heat_number = 'H-2' WHERE id = ${lot.id}`)).rejects.toThrow(/already set/i);
    // the owner is stopped by the trigger from rewriting a ledger column or clearing the heat
    await expect(owner.$executeRaw`UPDATE stock_lots SET qty = 99 WHERE id = ${lot.id}`).rejects.toThrow(/already set|append-only/i);
    const other = await f.lot(null);
    await expect(owner.$executeRaw`UPDATE stock_lots SET qty = 99, heat_number = 'H-3' WHERE id = ${other.id}`).rejects.toThrow(/append-only/i);
    await expect(owner.$executeRaw`UPDATE stock_lots SET heat_number = '' WHERE id = ${other.id}`).rejects.toThrow(/only be set to a value/i);
    expect((await owner.stockLot.findUniqueOrThrow({ where: { id: other.id } })).heatNumber).toBeNull();
  });

  it("the cross-job queue: only Stores, Planning, the Production Head and Admin; active jobs only; this tenant only", async () => {
    const { loadStoresQueue } = await import("./stores-queue.read");
    const mine = await fixture();
    // a PO is placed, one lot arrived with no heat number, nothing identified or issued
    await owner.procurementEvent.create({ data: { jobId: mine.j.job.id, bomItemId: mine.item.id, type: "PO_PLACED", by: actors.get("STORES")!.userId } });
    await mine.lot(null, "4");
    await owner.bomItem.update({ where: { id: mine.item.id }, data: { qtyPer: 10 } });
    // the same on a job that is on hold, and on another tenant's active job
    const held = await fixture();
    await owner.job.update({ where: { id: held.j.job.id }, data: { status: "ON_HOLD" } });
    await owner.procurementEvent.create({ data: { jobId: held.j.job.id, bomItemId: held.item.id, type: "PO_PLACED", by: actors.get("STORES")!.userId } });
    const theirs = await fixture(b);
    await owner.procurementEvent.create({ data: { jobId: theirs.j.job.id, bomItemId: theirs.item.id, type: "PO_PLACED", by: bStores.userId } });

    for (const r of ["OPERATOR", "SUPERVISOR", "QC", "MANAGEMENT", "ENGINEERING"]) {
      await expect(loadStoresQueue(actors.get(r)!), r).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(loadStoresQueue({ ...actors.get("STORES")!, clientId: o.tenantId })).rejects.toBeTruthy();

    for (const r of ["STORES", "PRODUCTION_HEAD", "ADMIN", "PLANNER"]) {
      const q = await loadStoresQueue(actors.get(r)!);
      const line = q.lines.find((l) => l.id === mine.item.id);
      expect(line, `${r} sees the line`).toBeTruthy();
      expect(line).toMatchObject({ jobNumber: mine.j.job.jobNumber, lotsWithoutHeat: 1, receivedQty: 4, issuedQty: 0 });
      expect(line!.needs).toEqual(["receive", "identify", "issue", "heat"]);
      expect(q.lines.some((l) => l.id === held.item.id), "an on-hold job is not queued").toBe(false);
      expect(q.lines.some((l) => l.id === theirs.item.id), "another tenant's line is never shown").toBe(false);
      expect(q.counts.heat).toBeGreaterThanOrEqual(1);
    }
    const theirsQ = await loadStoresQueue(bStores);
    expect(theirsQ.lines.map((l) => l.id)).toContain(theirs.item.id);
    expect(theirsQ.lines.map((l) => l.id)).not.toContain(mine.item.id);
  });

  it("a return cannot exceed what is out on issue, from the lot or from the named part", async () => {
    const f = await fixture();
    const lot = await f.lot("H-1", "10");
    const stores = actors.get("STORES")!;
    const ret = (qty: number, componentId?: number) => returnStock(stores, { stockLotId: lot.id, qty, componentId });
    const available = async () => (await owner.stockTxn.findMany({ where: { stockLotId: lot.id } })).reduce((n, t) => n + (t.type === "RETURN" ? -Number(t.qty) : Number(t.qty)), 0);

    await expect(ret(1)).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/Nothing is out on issue/) } });
    await issueStock(stores, { stockLotId: lot.id, qty: 4, componentId: f.comp });
    await expect(ret(5)).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/Only 4 is out on issue/) } });
    // 4 went to the part; a different part, and the part beyond what it got, are refused
    const other = (await owner.component.create({ data: { jobId: f.j.job.id, equipmentId: f.j.equipment.id, tag: "OTHER", componentTypeId: (await owner.component.findUniqueOrThrow({ where: { id: f.comp } })).componentTypeId } })).id;
    await expect(ret(1, other)).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/Nothing is out on issue to this part|Only 0|Nothing/) } });
    await expect(ret(5, f.comp)).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/Only 4 is out on issue to this part/) } });
    await ret(3, f.comp);
    await expect(ret(2, f.comp)).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/Only 1 is out/) } });
    await ret(1, f.comp);
    expect(await available()).toBe(0); // issued 4, returned 4: nothing out
    await expect(ret(1)).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/Nothing is out on issue/) } });
  });

  it("a lot's missing heat number cannot be added once its material has been cut into a part", async () => {
    const f = await fixture();
    const lot = await f.lot(null, "10");
    const stores = actors.get("STORES")!;
    await issueStock(stores, { stockLotId: lot.id, qty: 2, componentId: f.comp });
    await owner.componentOperation.update({ where: { id: f.j.op("SH-1", "CUTTING", 0) }, data: { status: "SUBMITTED" } });
    await expect(recordLotHeat(stores, { stockLotId: lot.id, heatNumber: "H-LATE" })).rejects.toMatchObject({
      detail: { reason: expect.stringMatching(/already been cut into a part/) },
    });
    expect((await owner.stockLot.findUniqueOrThrow({ where: { id: lot.id } })).heatNumber).toBeNull();
    // before the cutting is recorded it is fine
    await owner.componentOperation.update({ where: { id: f.j.op("SH-1", "CUTTING", 0) }, data: { status: "NOT_STARTED" } });
    await expect(recordLotHeat(stores, { stockLotId: lot.id, heatNumber: "H-OK" })).resolves.toMatchObject({ heatNumber: "H-OK" });
  });
});
