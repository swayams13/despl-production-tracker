import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * Lean Core L2.5, DB-gated: Team's read model (team.read.ts) and the bulk
 * assign (assignment.service.ts assignPlans). Access first, then the numbers,
 * then the writes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L2.5 Team (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadTeam } = await import("./team.read");
  const { assignPlans } = await import("./assignment.service");
  const { recordWork } = await import("./work.service");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  type Org = Awaited<ReturnType<typeof makeWorkOrg>>;
  let o: Org;
  let b: Org;
  let sup: Actor;
  let msSup: Actor;
  let head: Actor;
  let mgmt: Actor;
  let anil: Actor;
  let imran: Actor;
  let deepak: Actor;
  let bSup: Actor;
  let dept: { id: number; code: string; name: string };
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "TEAM");
    b = await makeWorkOrg(owner, "TEAMB");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    msSup = await o.user("mssup", ["SUPERVISOR"], [o.other.id]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    mgmt = await o.user("md", ["MANAGEMENT"]);
    anil = await o.user("anil", ["OPERATOR"], [o.fab.id]);
    imran = await o.user("imran", ["OPERATOR"], [o.fab.id]);
    deepak = await o.user("deepak", ["OPERATOR"], [o.fab.id]);
    bSup = await b.user("bsup", ["SUPERVISOR"], [b.fab.id]);
    dept = { id: o.fab.id, code: "FAB", name: "Fabrication" };
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? e.code : `NON_APP_ERROR: ${String(e)}`;
    }
    return null;
  };

  /** Five open plans: 2 to Anil (one overdue), 1 to Imran, 2 unassigned (one overdue). */
  async function fixture() {
    const past = new Date(Date.now() - 3 * 86_400_000);
    const future = new Date(Date.now() + 5 * 86_400_000);
    const j = await o.job({
      processes: [
        { code: "20", plannedFinish: past },
        { code: "21", plannedFinish: future },
        { code: "22", plannedFinish: future },
        { code: "23", plannedFinish: past },
        { code: "24", plannedFinish: future },
      ],
    });
    const set = (code: string, userId: number | null) =>
      owner.processPlan.update({ where: { id: j.plan(code, 0) }, data: { assigneeUserId: userId } });
    await set("20", anil.userId);
    await set("21", anil.userId);
    await set("22", imran.userId);
    return j;
  }

  describe("access", () => {
    it("members, the Production Head and Admin act; Management reads; another department gets nothing", async () => {
      await fixture();
      expect((await loadTeam(sup, dept))?.access).toBe("full");
      expect((await loadTeam(head, dept))?.access).toBe("full");
      expect((await loadTeam(mgmt, dept))?.access).toBe("readonly");
      expect(await loadTeam(msSup, dept)).toBeNull();
    });

    it("a client user is refused", async () => {
      expect(await code(loadTeam({ ...sup, clientId: 1 }, dept))).toBe(ERROR_CODES.FORBIDDEN);
    });

    it("never shows another tenant's work", async () => {
      const j = await fixture();
      const v = (await loadTeam(bSup, { id: b.fab.id, code: "FAB", name: "Fabrication" }))!;
      expect([...v.pool, ...v.people.flatMap((p) => p.items)].some((r) => r.jobId === j.job.id)).toBe(false);
    });
  });

  describe("the numbers", () => {
    it("open is assigned plus unassigned, and workload is per person", async () => {
      const j = await fixture();
      const v = (await loadTeam(sup, dept))!;
      const mineHere = (r: { jobId: number }) => r.jobId === j.job.id;
      const anilRow = v.people.find((p) => p.name === "anil")!;
      expect(anilRow.items.filter(mineHere)).toHaveLength(2);
      expect(anilRow.overdue).toBeGreaterThanOrEqual(1);
      expect(v.people.find((p) => p.name === "imran")!.items.filter(mineHere)).toHaveLength(1);
      expect(v.people.find((p) => p.name === "deepak")).toMatchObject({ assigned: 0, idle: true });
      expect(v.kpi.assigned + v.kpi.unassigned).toBe(v.kpi.open);
      expect(v.pool.filter(mineHere)).toHaveLength(2);
      expect(v.pool.filter(mineHere).every((r) => r.assigneeId == null)).toBe(true);
    });

    it("an overdue row with no reason says so, and one with a reason names it", async () => {
      const j = await fixture();
      await owner.delayReason.create({
        data: { jobId: j.job.id, processPlanId: j.plan("20", 0), categoryId: o.category.id, filedBy: sup.userId },
      });
      const v = (await loadTeam(sup, dept))!;
      const row = (code: string) => v.overdueBlocked.find((r) => r.planId === j.plan(code, 0))!;
      expect(row("20").reason).toEqual({ filed: true, category: "Material late" });
      expect(row("23").reason).toEqual({ filed: false, category: null });
      expect(row("23").overdue).toBe(true);
    });

    it("same-day updates compare recorded and reported time", async () => {
      const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1, requiresQc: false }, { seq: 2, requiresQc: false }] });
      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: "ASSEMBLY_STEP", id: j.step(1) }] });
      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: "ASSEMBLY_STEP", id: j.step(2) }] });
      const before = (await loadTeam(sup, dept))!.kpi;
      // yesterday's work entered today: not same-day
      await owner.assemblyStep.update({
        where: { id: j.step(2) },
        data: { reportedFinishAt: new Date(Date.now() - 30 * 3600 * 1000) },
      });
      const after = (await loadTeam(sup, dept))!.kpi;
      expect(after.sameDayTotal).toBe(before.sameDayTotal);
      expect(after.sameDayPct!).toBeLessThan(before.sameDayPct!);
    });

    it("lists out-of-order starts of this department's items only", async () => {
      const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1 }] });
      await owner.sequenceOverride.create({
        data: { jobId: j.job.id, targetKind: "ASSEMBLY_STEP", targetId: j.step(1), unitId: j.units[0].id, category: "CLIENT_PRIORITY", createdBy: sup.userId },
      });
      const v = (await loadTeam(sup, dept))!;
      expect(v.outOfSequence.map((x) => x.title)).toContain("step 1");
      // the Machine shop's view of the same job does not list a Fabrication step
      const ms = (await loadTeam(head, { id: o.other.id, code: "MS", name: "Machine shop" }))!;
      const jobNo = (await owner.job.findUniqueOrThrow({ where: { id: j.job.id } })).jobNumber;
      expect(ms.outOfSequence.filter((x) => x.jobNumber === jobNo)).toEqual([]);
    });

    it("D2: the Production Head sees the early-starts list and the ack state; the supervisor sees neither the list nor a button", async () => {
      const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1 }] });
      const ov = await owner.sequenceOverride.create({
        data: { jobId: j.job.id, targetKind: "ASSEMBLY_STEP", targetId: j.step(1), unitId: j.units[0].id, category: "CLIENT_PRIORITY", createdBy: sup.userId },
      });
      expect((await loadTeam(sup, dept))!.earlyStarts).toBeNull();
      const before = (await loadTeam(head, dept))!;
      expect(before.earlyStarts!.pending.map((p) => p.id)).toContain(ov.id);
      expect(before.outOfSequence.find((x) => x.id === ov.id)!.ack).toBeNull();

      await owner.sequenceOverrideAck.create({ data: { jobId: j.job.id, overrideId: ov.id, acknowledgedBy: head.userId } });
      const after = (await loadTeam(head, dept))!;
      expect(after.earlyStarts!.pending.map((p) => p.id)).not.toContain(ov.id);
      expect(after.outOfSequence.find((x) => x.id === ov.id)!.ack).toMatchObject({ by: "head" });
      // the supervisor still sees the entry, now marked, and never the list
      expect((await loadTeam(sup, dept))!.outOfSequence.find((x) => x.id === ov.id)!.ack).not.toBeNull();
    });
  });

  describe("assignPlans (bulk)", () => {
    it("assigns every plan to one person, each audited, and notifies them", async () => {
      const j = await o.job({ processes: [{ code: "30" }, { code: "31" }, { code: "32" }] });
      const ids = [j.plan("30", 0), j.plan("31", 0), j.plan("32", 0)];
      const r = await assignPlans(sup, { processPlanIds: ids, userId: deepak.userId });
      expect(r).toEqual({ assigned: ids, failed: [] });
      expect(await owner.processPlan.count({ where: { id: { in: ids }, assigneeUserId: deepak.userId } })).toBe(3);
      expect(await owner.auditLog.count({ where: { action: "assignment.assign", entityId: { in: ids.map(String) } } })).toBe(3);
      expect(await owner.notification.count({ where: { recipientId: deepak.userId, type: "PLAN_ASSIGNED", entityId: { in: ids } } })).toBe(3);
    });

    it("a plan the actor may not assign fails alone; the rest land", async () => {
      const j = await o.job({ processes: [{ code: "30" }, { code: "31" }] });
      // plan 31 belongs to Machine shop: the Fabrication supervisor may not assign it
      await owner.processPlan.update({ where: { id: j.plan("31", 0) }, data: { ownerDepartmentId: o.other.id } });
      const r = await assignPlans(sup, { processPlanIds: [j.plan("30", 0), j.plan("31", 0)], userId: anil.userId });
      expect(r.assigned).toEqual([j.plan("30", 0)]);
      expect(r.failed).toMatchObject([{ processPlanId: j.plan("31", 0), code: ERROR_CODES.FORBIDDEN }]);
      expect((await owner.processPlan.findUniqueOrThrow({ where: { id: j.plan("31", 0) } })).assigneeUserId).toBeNull();
    });

    it("a person outside the department is refused per plan", async () => {
      const j = await o.job({ processes: [{ code: "30" }] });
      const r = await assignPlans(sup, { processPlanIds: [j.plan("30", 0)], userId: msSup.userId });
      expect(r.assigned).toEqual([]);
      expect(r.failed[0].code).toBe(ERROR_CODES.ASSIGNEE_NOT_IN_DEPARTMENT);
    });

    it.each<[string, () => Promise<unknown>, string]>([
      ["nothing selected", () => assignPlans(sup, { processPlanIds: [], userId: anil.userId }), ERROR_CODES.VALIDATION_FAILED],
      ["more than a hundred", () => assignPlans(sup, { processPlanIds: Array.from({ length: 101 }, (_, i) => i + 1), userId: anil.userId }), ERROR_CODES.VALIDATION_FAILED],
      ["a client user", () => assignPlans({ ...sup, clientId: 1 }, { processPlanIds: [1], userId: anil.userId }), ERROR_CODES.FORBIDDEN],
      ["an operator (not a supervisor)", () => assignPlans(anil, { processPlanIds: [1], userId: imran.userId }), ERROR_CODES.FORBIDDEN],
    ])("refuses %s", async (_l, call, expected) => {
      expect(await code(call())).toBe(expected);
    });

    it("another tenant's plans are not found, never assigned", async () => {
      const j = await b.job({ processes: [{ code: "30" }] });
      const r = await assignPlans(sup, { processPlanIds: [j.plan("30", 0)], userId: anil.userId });
      expect(r.assigned).toEqual([]);
      expect(r.failed[0].code).toBe(ERROR_CODES.NOT_FOUND);
    });
  });
});
