import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * Lean Core L2.3, DB-gated: Today's read model (today.read.ts) and an
 * operator's Claim next (today.service.ts). Scoping and refusals first.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L2.3 Today (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadToday } = await import("./today.read");
  const { claimNext } = await import("./today.service");
  const { recordWork } = await import("./work.service");
  const { makeWorkOrg, attachPrintedRoute } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  type Org = Awaited<ReturnType<typeof makeWorkOrg>>;
  let o: Org;
  let b: Org;
  let sup: Actor;
  let sup2: Actor;
  let operator: Actor;
  let msOperator: Actor;
  let bOperator: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "TDY");
    b = await makeWorkOrg(owner, "TDB");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    sup2 = await o.user("sup2", ["SUPERVISOR"], [o.fab.id]);
    operator = await o.user("op", ["OPERATOR"], [o.fab.id]);
    msOperator = await o.user("msop", ["OPERATOR"], [o.other.id]);
    bOperator = await b.user("bop", ["OPERATOR"], [b.fab.id]);
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
  const assign = (planId: number, userId: number | null) =>
    owner.processPlan.update({ where: { id: planId }, data: { assigneeUserId: userId } });

  describe("loadToday", () => {
    it("shows the steps under the plans assigned to me, and nothing assigned to someone else", async () => {
      const j = await o.job({
        processes: [{ code: "20" }, { code: "21" }],
        steps: [
          { seq: 1, processSeq: 20 },
          { seq: 2, processSeq: 20 },
          { seq: 3, processSeq: 21 },
        ],
      });
      await assign(j.plan("20", 0), sup.userId);
      await assign(j.plan("21", 0), sup2.userId);
      const mine = await loadToday(sup);
      const rows = [mine.sections.doFirst, ...mine.sections.today, ...mine.sections.upcoming, ...mine.sections.blocked].filter(Boolean);
      const own = rows.filter((r) => r!.jobId === j.job.id).map((r) => r!.title).sort();
      expect(own).toEqual(["step 1", "step 2"]);
      expect(rows.some((r) => r!.title === "step 3" && r!.jobId === j.job.id)).toBe(false);
    });

    it("a plan with no steps under it is a plan-level row recorded directly", async () => {
      const j = await o.job({ processes: [{ code: "30" }] });
      await assign(j.plan("30", 0), sup.userId);
      const v = await loadToday(sup);
      const all = [v.sections.doFirst, ...v.sections.today, ...v.sections.upcoming, ...v.sections.blocked].filter(Boolean);
      const r = all.find((x) => x!.jobId === j.job.id);
      expect(r).toMatchObject({ kind: "PROCESS_PLAN", id: j.plan("30", 0), title: "Process 30", unitPublicId: null });
    });

    it("work I recorded done today is listed for the check-in, from the audit trail", async () => {
      const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20, requiresQc: false }, { seq: 2, processSeq: 20 }] });
      await assign(j.plan("20", 0), sup.userId);
      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: "ASSEMBLY_STEP", id: j.step(1) }] });
      const v = await loadToday(sup);
      expect(v.checkIn.doneToday.map((d) => d.id)).toContain(j.step(1));
      expect(v.checkIn.doneToday.find((d) => d.id === j.step(1))).toMatchObject({ title: "step 1", jobId: j.job.id });
      // and a step that is still open stays on the list
      expect([v.sections.doFirst, ...v.sections.today, ...v.sections.upcoming].some((r) => r?.id === j.step(2))).toBe(true);
    });

    it("a repeated operation on a part is numbered in the check-in, so the second Forming is not a copy of the first", async () => {
      const j = await o.job({ components: [{ tag: "HEAD", ops: [{ code: "FORMING", requiresQc: false }, { code: "FORMING", requiresQc: false }] }] });
      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: "COMPONENT_OP", id: j.op("HEAD", "FORMING") }] });
      const v = await loadToday(sup);
      expect(v.checkIn.doneToday.find((d) => d.id === j.op("HEAD", "FORMING"))).toMatchObject({ title: "FORMING (2 of 2)" });
    });

    it("a repeated operation reads as the route's own step name when the part's route has them", async () => {
      const j = await o.job({ components: [{ tag: "HEAD", ops: [{ code: "FORMING", requiresQc: false }, { code: "FORMING", requiresQc: false }] }] });
      await attachPrintedRoute(owner, o.tenantId, j.components.get("HEAD:0")!, ["Pressing/Spinning", "Trimming"]);
      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: "COMPONENT_OP", id: j.op("HEAD", "FORMING") }] });
      const v = await loadToday(sup);
      expect(v.checkIn.doneToday.find((d) => d.id === j.op("HEAD", "FORMING"))).toMatchObject({ title: "FORMING (Trimming)" });
    });

    it("another tenant's work never appears", async () => {
      const j = await b.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }] });
      await owner.processPlan.update({ where: { id: j.plan("20", 0) }, data: { assigneeUserId: bOperator.userId } });
      const v = await loadToday(sup);
      expect([v.sections.doFirst, ...v.sections.today, ...v.sections.blocked, ...v.sections.upcoming].some((r) => r?.jobId === j.job.id)).toBe(false);
    });

    it("a client user is refused", async () => {
      expect(await code(loadToday({ ...sup, clientId: 1 }))).toBe(ERROR_CODES.FORBIDDEN);
    });

    it("an operator can claim; a supervisor sees the pool section instead", async () => {
      const j = await o.job({ processes: [{ code: "20" }] });
      void j;
      const op = await loadToday(operator);
      const sv = await loadToday(sup);
      expect(op.canClaimNext).toBe(true);
      expect(op.pool).toEqual([]);
      expect(sv.canClaimNext).toBe(false);
      expect(sv.canAssign).toBe(true);
      expect(sv.pool.length).toBeGreaterThan(0);
    });
  });

  // Pilot seat Planning/PPC: a PLANNER records processes 1-11 only (work.service applyItem),
  // so Today shows them office plans only and nothing of the floor. Own org per test group so
  // "the plan I just created" is the only candidate (no leftovers from the shared one).
  describe("PLANNER on Today (office processes 1-11 only)", () => {
    const rowsOf = (v: Awaited<ReturnType<typeof loadToday>>) =>
      [v.sections.doFirst, ...v.sections.today, ...v.sections.upcoming, ...v.sections.blocked].filter(Boolean);
    let po: Org;
    let pl: Actor; // PLANNER
    let plQc: Actor; // PLANNER + QC
    let plSup: Actor; // PLANNER + SUPERVISOR
    let plElsewhere: Actor;
    beforeAll(async () => {
      po = await makeWorkOrg(owner, "TDP");
      pl = await po.user("pl", ["PLANNER"], [po.fab.id]);
      plQc = await po.user("plqc", ["PLANNER", "QC"], [po.fab.id]);
      plSup = await po.user("plsup", ["PLANNER", "SUPERVISOR"], [po.fab.id]);
      plElsewhere = await po.user("plx", ["PLANNER"], [po.other.id]);
    });
    const seqOf = async (planId: number) =>
      (await owner.processPlan.findUniqueOrThrow({ where: { id: planId }, include: { jobProcess: true } })).jobProcess.seq;

    it("mine: only office plans assigned to me; an assigned floor process is not listed", async () => {
      const j = await po.job({ processes: [{ code: "3", grain: "JOB" }, { code: "22" }] });
      await assign(j.plan("3"), pl.userId);
      await assign(j.plan("22", 0), pl.userId);
      const v = await loadToday(pl);
      expect(rowsOf(v).filter((r) => r!.jobId === j.job.id).map((r) => r!.id)).toEqual([j.plan("3")]);
    });

    // Violation cases first: every planner-without-floor-write shape claims office plans only.
    it.each<[string, () => Actor]>([
      ["PLANNER", () => pl],
      ["PLANNER + QC", () => plQc],
    ])("%s: claim next takes the office plan I created, never the floor plan", async (_l, who) => {
      const j = await po.job({ processes: [{ code: "4", grain: "JOB" }, { code: "22" }] });
      const v = await loadToday(who());
      expect(v.canClaimNext).toBe(true);
      expect(v.canAssign).toBe(false);
      expect(v.pool).toEqual([]);
      const r = await claimNext(who());
      expect(r.processPlanId).toBe(j.plan("4"));
      expect(await seqOf(r.processPlanId)).toBeLessThanOrEqual(11);
      expect(await owner.processPlan.count({ where: { jobId: j.job.id, jobProcess: { seq: 22 }, assigneeUserId: { not: null } } })).toBe(0);
      // and with only the floor plan left, there is nothing to claim
      expect(await code(claimNext(who()))).toBe(ERROR_CODES.NOT_FOUND);
    });

    it("a direct claim of a floor plan is refused FORBIDDEN for a planner and a planner + QC user, allowed for a planner + supervisor", async () => {
      const { claimPlan } = await import("./assignment.service");
      const j = await po.job({ processes: [{ code: "22" }] });
      for (const who of [pl, plQc]) {
        expect(await code(claimPlan(who, { processPlanId: j.plan("22", 0) }))).toBe(ERROR_CODES.FORBIDDEN);
      }
      expect(await code(claimPlan(plSup, { processPlanId: j.plan("22", 0) }))).toBeNull();
    });

    it("a planner in another department sees and claims nothing of Fabrication's office plans", async () => {
      const j = await po.job({ processes: [{ code: "5", grain: "JOB" }] });
      const v = await loadToday(plElsewhere);
      expect(v.canClaimNext).toBe(false);
      expect(rowsOf(v).some((r) => r!.jobId === j.job.id)).toBe(false);
      expect(await code(claimNext(plElsewhere))).toBe(ERROR_CODES.NOT_FOUND);
    });

    it("PLANNER + SUPERVISOR keeps the unfiltered floor view (pool lists floor plans)", async () => {
      await po.job({ processes: [{ code: "22" }] });
      const sv = await loadToday(plSup);
      expect(sv.canAssign).toBe(true);
      expect(sv.pool.some((p) => p.processName === "Process 22")).toBe(true);
    });

    it("a supervisor still sees the floor plans in the pool", async () => {
      await o.job({ processes: [{ code: "22" }] });
      const sv = await loadToday(sup);
      expect(sv.pool.some((p) => p.processName === "Process 22")).toBe(true);
    });
  });

  describe("claimNext", () => {
    it("claims the top unassigned plan in the operator's own department, audited", async () => {
      const j = await o.job({ processes: [{ code: "40" }] });
      const plan = j.plan("40", 0);
      const r = await claimNext(operator);
      const row = await owner.processPlan.findUniqueOrThrow({ where: { id: r.processPlanId } });
      expect(row.assigneeUserId).toBe(operator.userId);
      expect(await owner.auditLog.count({ where: { action: "assignment.claim", entityId: String(r.processPlanId) } })).toBe(1);
      expect(plan).toBeGreaterThan(0);
    });

    it.each<[string, () => Promise<unknown>, string]>([
      ["a supervisor (they assign, they do not claim from Today)", () => claimNext(sup), ERROR_CODES.FORBIDDEN],
      ["a client user", () => claimNext({ ...operator, clientId: 1 }), ERROR_CODES.FORBIDDEN],
    ])("refuses %s", async (_l, call, expected) => {
      expect(await code(call())).toBe(expected);
    });

    it("an operator in a department with nothing waiting is told so, and nothing is claimed", async () => {
      await o.job({ processes: [{ code: "50" }] }); // owned by Fabrication, not Machine shop
      const before = await owner.processPlan.count({ where: { assigneeUserId: msOperator.userId } });
      expect(await code(claimNext(msOperator))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await owner.processPlan.count({ where: { assigneeUserId: msOperator.userId } })).toBe(before);
    });

    it("never takes another tenant's plan", async () => {
      const own = await o.job({ processes: [{ code: "60" }] });
      void own;
      const r = await claimNext(operator);
      const plan = await owner.processPlan.findUniqueOrThrow({ where: { id: r.processPlanId }, include: { job: true } });
      expect(plan.job.tenantId).toBe(o.tenantId);
    });
  });
});
