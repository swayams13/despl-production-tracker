import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import type { WorkOrg } from "./work.test-util";

/**
 * Lean Core L2.13, DB-gated: picking a heat number where the part is cut. Refusals
 * first; then the pick, its effect on D2's H2, and issue-and-pick.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const HOUR = 60 * 60 * 1000;

describe.skipIf(!RUN_DB)("L2.13 heat number at cutting (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { makeWorkOrg } = await import("./work.test-util");
  const { loadHeatChoices, pickHeatNumber, issueAndPickHeat } = await import("./heat.service");
  const { recordWork } = await import("./work.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  let sup: Actor;
  let supMs: Actor;
  let operator: Actor;
  let head: Actor;
  let admin: Actor;
  let planner: Actor;
  let qc: Actor;
  let bHead: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "HTA");
    b = await makeWorkOrg(owner, "HTB");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    supMs = await o.user("supms", ["SUPERVISOR"], [o.other.id]);
    operator = await o.user("operator", ["OPERATOR"], [o.fab.id]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    admin = await o.user("admin", ["ADMIN"]);
    planner = await o.user("planner", ["PLANNER"]);
    qc = await o.user("qc", ["QC"]);
    bHead = await b.user("bhead", ["PRODUCTION_HEAD"]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  /** A job with one pressure part and one non-pressure part, each linked to a BOM line with lots. */
  async function setup(org: WorkOrg = o, lots: Array<{ heat: string | null; qty: number }> = [{ heat: "H-1001", qty: 10 }, { heat: "H-1002", qty: 5 }, { heat: null, qty: 3 }]) {
    const j = await org.job({
      components: [
        { tag: "SH-1", pressure: true, drawing: "RELEASED", ops: [{ code: "CUTTING", requiresQc: false }] },
        { tag: "BR-1", pressure: false, ops: [{ code: "CUTTING", requiresQc: false }] },
      ],
    });
    const bom = async (tag: string, partName: string) => {
      const item = await owner.bomItem.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, itemNo: tag === "SH-1" ? 1 : 2, partName, sourceQty: "1", qtyPer: 2 } });
      await owner.component.update({ where: { id: j.components.get(`${tag}:0`)! }, data: { bomItemId: item.id } });
      const made = [];
      for (const l of lots) made.push(await owner.stockLot.create({ data: { jobId: j.job.id, bomItemId: item.id, heatNumber: l.heat, location: "Y1", qty: String(l.qty) } }));
      return { item, lots: made };
    };
    const shell = await bom("SH-1", "SHELL PLATE");
    const bracket = await bom("BR-1", "BRACKET");
    return { j, shell, bracket, comp: j.components.get("SH-1:0")!, compBr: j.components.get("BR-1:0")! };
  }

  it("lists only lots that have a heat number, with what is left in each", async () => {
    const s = await setup();
    await owner.stockTxn.create({ data: { jobId: s.j.job.id, stockLotId: s.shell.lots[0].id, type: "ISSUE", qty: "4", by: head.userId } });
    await owner.stockTxn.create({ data: { jobId: s.j.job.id, stockLotId: s.shell.lots[0].id, type: "RETURN", qty: "1", by: head.userId } });
    const c = await loadHeatChoices(sup, s.comp);
    expect(c).toMatchObject({ partName: "SHELL PLATE", need: 2, picked: null });
    expect(c.lots.map((l) => [l.heatNumber, l.available])).toEqual([["H-1001", 7], ["H-1002", 5]]);
  });

  it("picks a heat number: records the identification, audited, and H2 no longer refuses for it", async () => {
    const s = await setup();
    // issue from the lot with no heat number: material issued, heat not picked
    await owner.stockTxn.create({ data: { jobId: s.j.job.id, stockLotId: s.shell.lots[2].id, type: "ISSUE", qty: "2", by: head.userId, componentId: s.comp } });
    const cut = s.j.op("SH-1", "CUTTING", 0);
    const before = await recordWork(sup, { jobId: s.j.job.id, action: "DONE", items: [{ kind: "COMPONENT_OP", id: cut }] });
    expect(before.refused[0].code).toBe("HEAT_NUMBER_NOT_PICKED");

    const r = await pickHeatNumber(sup, { componentId: s.comp, stockLotId: s.shell.lots[0].id });
    expect(r).toEqual({ heatNumber: "H-1001", created: true });
    const mi = await owner.materialIdentification.findMany({ where: { componentId: s.comp } });
    expect(mi.map((m) => [m.heatNumber, m.bomItemId, m.jobId])).toEqual([["H-1001", s.shell.item.id, s.j.job.id]]);
    expect(await owner.auditLog.count({ where: { tenantId: o.tenantId, action: "heat.pick", entityId: String(mi[0].id) } })).toBe(1);

    const after = await recordWork(sup, { jobId: s.j.job.id, action: "DONE", reportedAt: new Date(Date.now() - HOUR).toISOString(), items: [{ kind: "COMPONENT_OP", id: cut }] });
    expect(after.refused).toEqual([]);
    expect(after.applied[0].to).toBe("COMPLETE");
  });

  it("the Floor row for a cutting item refused only for a heat number says which part to pick for, and clears once picked", async () => {
    const { loadFloorUnit } = await import("./floor.read");
    const s = await setup();
    await owner.stockTxn.create({ data: { jobId: s.j.job.id, stockLotId: s.shell.lots[2].id, type: "ISSUE", qty: "2", by: head.userId, componentId: s.comp } });
    const cutting = async () => (await loadFloorUnit(sup, { unitId: s.j.units[0].id }))!.rows.find((r) => r.kind === "COMPONENT_OP" && r.id === s.j.op("SH-1", "CUTTING", 0))!;
    const before = await cutting();
    expect(before).toMatchObject({ state: "BLOCKED", heatComponentId: s.comp });
    expect(before.refusal?.code).toBe("HEAT_NUMBER_NOT_PICKED");
    // the part that needs no heat number never offers one
    const other = (await loadFloorUnit(sup, { unitId: s.j.units[0].id }))!.rows.find((r) => r.id === s.j.op("BR-1", "CUTTING", 0))!;
    expect(other.heatComponentId).toBeNull();

    await pickHeatNumber(sup, { componentId: s.comp, stockLotId: s.shell.lots[0].id });
    expect(await cutting()).toMatchObject({ state: "READY", heatComponentId: null });
  });

  it("picking the same heat again is a no-op; a different one is refused", async () => {
    const s = await setup();
    await pickHeatNumber(sup, { componentId: s.comp, stockLotId: s.shell.lots[0].id });
    expect(await pickHeatNumber(sup, { componentId: s.comp, stockLotId: s.shell.lots[0].id })).toEqual({ heatNumber: "H-1001", created: false });
    await expect(pickHeatNumber(sup, { componentId: s.comp, stockLotId: s.shell.lots[1].id })).rejects.toMatchObject({
      detail: { reason: expect.stringMatching(/already has heat number H-1001/) },
    });
    expect(await owner.materialIdentification.count({ where: { componentId: s.comp } })).toBe(1);
  });

  it("refuses a lot of another part, a lot with no heat number, and a part that needs none", async () => {
    const s = await setup();
    await expect(pickHeatNumber(sup, { componentId: s.comp, stockLotId: s.bracket.lots[0].id })).rejects.toMatchObject({
      detail: { reason: expect.stringMatching(/not received for this part/) },
    });
    await expect(pickHeatNumber(sup, { componentId: s.comp, stockLotId: s.shell.lots[2].id })).rejects.toMatchObject({
      detail: { reason: expect.stringMatching(/Ask Stores/) },
    });
    await expect(pickHeatNumber(sup, { componentId: s.compBr, stockLotId: s.bracket.lots[0].id })).rejects.toMatchObject({
      detail: { reason: expect.stringMatching(/Only a pressure part/) },
    });
    expect(await owner.materialIdentification.count({ where: { jobId: s.j.job.id } })).toBe(0);
  });

  it("a part with no BOM line has nothing to pick from", async () => {
    const j = await o.job({ components: [{ tag: "X-1", pressure: true, ops: [{ code: "CUTTING" }] }] });
    await expect(loadHeatChoices(sup, j.components.get("X-1:0")!)).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/not linked to a BOM line/) } });
  });

  it("only floor roles in the cutting department; never planner, QC, a client user or another tenant", async () => {
    const s = await setup();
    const pick = (a: Actor) => pickHeatNumber(a, { componentId: s.comp, stockLotId: s.shell.lots[0].id });
    for (const who of [planner, qc]) await expect(pick(who)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(pick(supMs)).rejects.toMatchObject({ code: "FORBIDDEN" }); // another department
    await expect(pick({ ...sup, clientId: o.tenantId })).rejects.toBeTruthy();
    await expect(pick(bHead)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(loadHeatChoices(qc, s.comp)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await owner.materialIdentification.count({ where: { jobId: s.j.job.id } })).toBe(0);
    await expect(pick(operator)).resolves.toMatchObject({ created: true });
  });

  it("issue and pick: Production Head and Admin only; issues once, picks, and a repeat does not issue twice", async () => {
    const s = await setup();
    const run = (a: Actor, lot = s.shell.lots[0].id, qty = 2) => issueAndPickHeat(a, { componentId: s.comp, stockLotId: lot, qty });
    for (const who of [sup, operator, planner]) await expect(run(who)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(head, s.shell.lots[0].id, 99)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await owner.materialIdentification.count({ where: { componentId: s.comp } })).toBe(0);

    expect(await run(head)).toEqual({ heatNumber: "H-1001", issued: true });
    expect(await owner.stockTxn.count({ where: { componentId: s.comp, type: "ISSUE" } })).toBe(1);
    expect(await run(admin)).toEqual({ heatNumber: "H-1001", issued: false });
    expect(await owner.stockTxn.count({ where: { componentId: s.comp, type: "ISSUE" } })).toBe(1);
    expect(await owner.materialIdentification.count({ where: { componentId: s.comp } })).toBe(1);
  });

  it("issue and pick checks before it issues: a lot with no heat number issues nothing", async () => {
    const s = await setup();
    await expect(issueAndPickHeat(head, { componentId: s.comp, stockLotId: s.shell.lots[2].id, qty: 1 })).rejects.toMatchObject({
      detail: { reason: expect.stringMatching(/Ask Stores/) },
    });
    expect(await owner.stockTxn.count({ where: { componentId: s.comp } })).toBe(0);
    await expect(issueAndPickHeat(head, { componentId: s.comp, stockLotId: s.shell.lots[0].id, qty: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
