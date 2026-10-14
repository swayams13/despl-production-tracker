import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { JobSpec, WorkJob, WorkOrg } from "./work.test-util";

/**
 * Lean Core L1.2e, DB-gated: inspect (QC's one write), the leanFloor switch on
 * the legacy paths, and the unit lock on the QC writers. Violation cases first.
 * LEAN_FLOOR is set per case and restored; the services themselves are not
 * flag-gated, only the legacy paths' DERIVED_STATUS / rollup are.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const FLOOR_LOCK_UNIT = 1202;

describe.skipIf(!RUN_DB)("L1.2e inspect, derived switch, unit lock (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { recordWork } = await import("./work.service");
  const { inspect } = await import("./work.service");
  const { startProcess, submitProcess, verifyProcess, holdProcess } = await import("./process.service");
  const { startAssemblyStep, submitAssemblyStep, verifyAssemblyStep, rejectAssemblyStep } = await import("./assembly.service");
  const { startComponentOperation, submitComponentOperation, verifyComponentOperation, rejectComponentOperation } =
    await import("./component.service");
  const { recordQcpExecution } = await import("./qcp.service");
  const { dispositionNcr } = await import("./ncr.service");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  let sup: Actor;
  let supQc: Actor;
  let adminQc: Actor;
  let head: Actor;
  let qc: Actor;
  let qc2: Actor;
  let bQc: Actor;
  let reworkCategoryId: number;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "I");
    b = await makeWorkOrg(owner, "J");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    supQc = await o.user("supqc", ["SUPERVISOR", "QC"], [o.fab.id]);
    adminQc = await o.user("adminqc", ["ADMIN", "QC"]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    qc = await o.user("qc", ["QC"]);
    qc2 = await o.user("qc2", ["QC"]);
    bQc = await b.user("bqc", ["QC"]);
    reworkCategoryId = (
      await owner.delayCategoryRef.create({ data: { tenantId: o.tenantId, code: "REWORK_QUALITY", name: "Rework / quality" } })
    ).id;
  });
  afterEach(() => {
    delete process.env.LEAN_FLOOR;
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const S = "ASSEMBLY_STEP" as const;
  const OP = "COMPONENT_OP" as const;
  const P = "PROCESS_PLAN" as const;
  type Kind = typeof S | typeof OP | typeof P;
  const work = (actor: Actor, j: WorkJob, action: "START" | "DONE", items: Array<[Kind, number]>) =>
    recordWork(actor, { jobId: j.job.id, action, items: items.map(([kind, id]) => ({ kind, id })) });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? e.code : `NON_APP_ERROR: ${String(e)}`;
    }
    return null;
  };
  const stepRow = (id: number) => owner.assemblyStep.findUniqueOrThrow({ where: { id } });
  const opRow = (id: number) => owner.componentOperation.findUniqueOrThrow({ where: { id } });
  const planStatus = async (id: number) => (await owner.processPlan.findUniqueOrThrow({ where: { id } })).status;
  const inspectStep = (actor: Actor, id: number, result: "ACCEPT" | "REJECT" = "ACCEPT", extra: object = {}) =>
    inspect(actor, { kind: S, targetId: id, result, ...(result === "REJECT" ? { reason: "undercut" } : {}), ...extra });

  /** A single WORK step in process 20, submitted to QC by `by`. */
  async function submittedStep(by: Actor) {
    const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }] });
    const r = await work(by, j, "DONE", [[S, j.step(1)]]);
    expect(r.applied, JSON.stringify(r.refused)).toMatchObject([{ to: "SUBMITTED" }]);
    return j;
  }

  const holdSpec: JobSpec = {
    processes: [{ code: "20" }],
    steps: [
      { seq: 1, processSeq: 20, requiresQc: false },
      { seq: 2, kind: "INSPECTION", processSeq: 20, hold: true },
    ],
  };
  /** The step's own H point is also linked to process 20, as createJob links QCP items: the plan-level hold gate sees it. */
  async function holdJob() {
    const j = await o.job(holdSpec);
    for (const qcpItemId of j.stepQcp.values()) {
      await owner.qcpItemProcess.create({ data: { qcpItemId, jobProcessId: j.processes.get("20")!, jobId: j.job.id } });
    }
    return j;
  }

  /** WORK step 1 (QC-free) then INSPECTION step 2 with a blocking H point, both in process 20. */
  async function inspectionJob(workedBy: Actor) {
    const j = await holdJob();
    const r = await work(workedBy, j, "DONE", [[S, j.step(1)]]);
    expect(r.applied, JSON.stringify(r.refused)).toMatchObject([{ to: "COMPLETE" }]);
    return j;
  }

  // ── inspect: refusals ───────────────────────────────────────────────────
  describe("inspect refusals", () => {
    it.each<[string, () => Actor, string]>([
      ["a Production Head without the QC role", () => head, ERROR_CODES.FORBIDDEN],
      ["a supervisor", () => sup, ERROR_CODES.FORBIDDEN],
      ["the QC-role supervisor who submitted it (maker-checker)", () => supQc, ERROR_CODES.MAKER_CHECKER_VIOLATION],
      ["an ADMIN holding QC who submitted it: no admin exception", () => adminQc, ERROR_CODES.MAKER_CHECKER_VIOLATION],
    ])("%s is refused %s on ACCEPT and on REJECT; nothing changes", async (_l, who, expected) => {
      const j = await submittedStep(who().roles.includes("ADMIN") ? adminQc : supQc);
      for (const result of ["ACCEPT", "REJECT"] as const) {
        expect(await code(inspectStep(who(), j.step(1), result))).toBe(expected);
      }
      const s = await stepRow(j.step(1));
      expect(s.status).toBe("SUBMITTED");
      expect(await planStatus(j.plan("20", 0))).toBe("IN_PROGRESS");
      expect(await owner.ncr.count({ where: { jobId: j.job.id } })).toBe(0);
    });

    it("a client user is refused FORBIDDEN", async () => {
      const j = await submittedStep(sup);
      expect(await code(inspectStep({ ...qc, clientId: 1 }, j.step(1)))).toBe(ERROR_CODES.FORBIDDEN);
    });

    it("another tenant's item is NOT_FOUND", async () => {
      const j = await submittedStep(sup);
      expect(await code(inspectStep(bQc, j.step(1)))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await code(inspect(bQc, { kind: OP, targetId: j.step(1), result: "ACCEPT" }))).toBe(ERROR_CODES.NOT_FOUND);
    });

    it("REJECT without a reason is refused by the schema; nothing is written", async () => {
      const j = await submittedStep(sup);
      await expect(inspect(qc, { kind: S, targetId: j.step(1), result: "REJECT" })).rejects.toThrow();
      expect((await stepRow(j.step(1))).status).toBe("SUBMITTED");
    });

    it("a client-sent time is refused (strict schema)", async () => {
      const j = await submittedStep(sup);
      await expect(
        inspect(qc, { kind: S, targetId: j.step(1), result: "ACCEPT", finishedAt: new Date().toISOString() } as never),
      ).rejects.toThrow();
    });

    it("an item nobody has done yet is INVALID_STATE_TRANSITION (a WORK step is never accepted from NOT_STARTED)", async () => {
      const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }] });
      expect(await code(inspectStep(qc, j.step(1)))).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
      expect((await stepRow(j.step(1))).status).toBe("NOT_STARTED");
    });

    it("an already accepted INSPECTION step cannot be accepted again", async () => {
      const j = await inspectionJob(sup);
      await inspectStep(qc, j.step(2));
      expect(await code(inspectStep(qc2, j.step(2)))).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
    });

    it("a derived plan is DERIVED_STATUS; there is nothing to inspect on it", async () => {
      const j = await submittedStep(sup);
      expect(await code(inspect(qc, { kind: P, targetId: j.plan("20", 0), result: "ACCEPT" }))).toBe(ERROR_CODES.DERIVED_STATUS);
      expect(await planStatus(j.plan("20", 0))).toBe("IN_PROGRESS");
    });

    it("D11: the QC user who recorded the preceding work step cannot inspect it; another QC user can", async () => {
      const j = await inspectionJob(supQc);
      expect(await code(inspectStep(supQc, j.step(2)))).toBe(ERROR_CODES.MAKER_CHECKER_VIOLATION);
      expect(await code(inspectStep(supQc, j.step(2), "REJECT"))).toBe(ERROR_CODES.MAKER_CHECKER_VIOLATION);
      expect((await stepRow(j.step(2))).status).toBe("NOT_STARTED");
      expect(await owner.qcpExecution.count({ where: { jobId: j.job.id } })).toBe(0);
      expect(await code(inspectStep(qc, j.step(2)))).toBeNull();
    });

    // Review fix (14 Oct): an INSPECTION step needs its work done, and a maker who is not the inspector.
    describe("INSPECTION step: work precondition and every maker", () => {
      const W = (seq: number, extra: object = {}) => ({ seq, processSeq: 20, requiresQc: false, ...extra });
      const I = (seq: number, extra: object = {}) => ({ seq, kind: "INSPECTION" as const, processSeq: 20, hold: true, ...extra });
      const setStep = (id: number, status: "IN_PROGRESS" | "COMPLETE", by: Actor | null) =>
        owner.assemblyStep.update({ where: { id }, data: { status, submittedBy: by?.userId ?? null, startedAt: new Date() } });

      it.each<[string, JobSpec["steps"], (j: WorkJob) => Promise<unknown>]>([
        ["the preceding work step not started", [W(1), I(2)], async () => {}],
        ["the preceding work step in progress", [W(1), I(2)], (j) => setStep(j.step(1), "IN_PROGRESS", null)],
        ["one of two preceding work steps not done", [W(1), W(2), I(3)], (j) => setStep(j.step(2), "COMPLETE", sup)],
        ["the work step on the inspection's joint not done", [W(1, { jointRef: "J1" }), W(2, { jointRef: "J2" }), I(3, { jointRef: "J1" })], (j) => setStep(j.step(2), "COMPLETE", sup)],
      ])("ACCEPT with %s is refused INSPECT_PRECONDITION; no QCP execution, nothing changes", async (_l, steps, prep) => {
        const j = await o.job({ processes: [{ code: "20" }], steps });
        await prep(j);
        const target = j.step(steps!.length);
        expect(await code(inspectStep(qc, target))).toBe(ERROR_CODES.INSPECT_PRECONDITION);
        expect((await stepRow(target)).status).toBe("NOT_STARTED");
        expect(await owner.qcpExecution.count({ where: { jobId: j.job.id } })).toBe(0);
      });

      it("a work step on another joint does not hold the inspection back (H1 scope)", async () => {
        const j = await o.job({ processes: [{ code: "20" }], steps: [W(1, { jointRef: "J2" }), W(2, { jointRef: "J1" }), I(3, { jointRef: "J1" })] });
        await setStep(j.step(2), "COMPLETE", sup);
        expect(await code(inspectStep(qc, j.step(3)))).toBeNull();
      });

      it("no preceding work step at all: MAKER_CHECKER_VIOLATION on ACCEPT and REJECT", async () => {
        const j = await o.job({ processes: [{ code: "20" }], steps: [I(1)] });
        for (const result of ["ACCEPT", "REJECT"] as const) {
          expect(await code(inspectStep(qc, j.step(1), result))).toBe(ERROR_CODES.MAKER_CHECKER_VIOLATION);
        }
        expect(await owner.qcpExecution.count({ where: { jobId: j.job.id } })).toBe(0);
      });

      it("the QC user who recorded an earlier (not the nearest) work step of the group is refused", async () => {
        const j = await o.job({ processes: [{ code: "20" }], steps: [W(1), W(2), I(3)] });
        await setStep(j.step(1), "COMPLETE", supQc);
        await setStep(j.step(2), "COMPLETE", sup);
        for (const result of ["ACCEPT", "REJECT"] as const) {
          expect(await code(inspectStep(supQc, j.step(3), result))).toBe(ERROR_CODES.MAKER_CHECKER_VIOLATION);
        }
        expect(await code(inspectStep(qc, j.step(3)))).toBeNull();
      });
    });

    it("a Production Head holding QC who recorded the preceding work is refused too (no D11 exception yet)", async () => {
      const headQc = await o.user("headqc", ["PRODUCTION_HEAD", "QC"], [o.fab.id]);
      const j = await inspectionJob(headQc);
      expect(await code(inspectStep(headQc, j.step(2)))).toBe(ERROR_CODES.MAKER_CHECKER_VIOLATION);
    });

    it("a reject needs a rejection category: none set up and none given is refused; a given one passes", async () => {
      const j = await b.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }] });
      const bSup = await b.user("bsup", ["SUPERVISOR"], [b.fab.id]);
      await work(bSup, j, "DONE", [[S, j.step(1)]]);
      expect(await code(inspectStep(bQc, j.step(1), "REJECT"))).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(await code(inspectStep(bQc, j.step(1), "REJECT", { categoryId: b.category.id }))).toBeNull();
      // A category of another tenant is not usable.
      const k = await b.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }] });
      await work(bSup, k, "DONE", [[S, k.step(1)]]);
      expect(await code(inspectStep(bQc, k.step(1), "REJECT", { categoryId: o.category.id }))).toBe(ERROR_CODES.NOT_FOUND);
    });
  });

  // ── inspect: what it does ───────────────────────────────────────────────
  describe("inspect", () => {
    it("ACCEPT of a submitted WORK step: COMPLETE, verifier recorded, plan rolled up", async () => {
      const j = await submittedStep(sup);
      const r = await inspectStep(qc, j.step(1));
      expect(r).toMatchObject({ from: "SUBMITTED", to: "COMPLETE", rolledUp: [{ from: "IN_PROGRESS", to: "COMPLETE" }] });
      const s = await stepRow(j.step(1));
      expect([s.status, s.verifiedBy, s.finishedAt != null]).toEqual(["COMPLETE", qc.userId, true]);
      expect(await planStatus(j.plan("20", 0))).toBe("COMPLETE");
      expect(await owner.auditLog.count({ where: { tenantId: o.tenantId, entityType: "ProcessPlan", entityId: String(j.plan("20", 0)), action: "process.rollup" } })).toBeGreaterThan(0);
    });

    it("REJECT of a submitted WORK step: back to IN_PROGRESS, rejection + NCR opened, plan stays IN_PROGRESS", async () => {
      const j = await submittedStep(sup);
      const r = await inspectStep(qc, j.step(1), "REJECT");
      expect(r).toMatchObject({ from: "SUBMITTED", to: "IN_PROGRESS" });
      const s = await stepRow(j.step(1));
      expect([s.status, s.submittedBy]).toEqual(["IN_PROGRESS", null]);
      const rej = await owner.assemblyStepRejection.findFirstOrThrow({ where: { assemblyStepId: j.step(1) } });
      expect([rej.detail, rej.categoryId, rej.rejectedBy]).toEqual(["undercut", reworkCategoryId, qc.userId]);
      expect(await owner.ncr.count({ where: { assemblyStepRejectionId: rej.id } })).toBe(1);
      expect(await planStatus(j.plan("20", 0))).toBe("IN_PROGRESS");
    });

    it("ACCEPT of an INSPECTION step completes it from NOT_STARTED, records the QCP execution and clears the H point (rollup)", async () => {
      const j = await inspectionJob(sup);
      // The H point on the inspection step is still open, so the plan is not done yet.
      expect(await planStatus(j.plan("20", 0))).toBe("IN_PROGRESS");

      const r = await inspectStep(qc, j.step(2));
      expect(r).toMatchObject({ from: "NOT_STARTED", to: "COMPLETE", rolledUp: [{ from: "IN_PROGRESS", to: "COMPLETE" }] });
      const s = await stepRow(j.step(2));
      expect([s.status, s.verifiedBy]).toEqual(["COMPLETE", qc.userId]);
      expect(s.startedAt, "started is stamped so the plan's actualStart counts it").not.toBeNull();
      const exec = await owner.qcpExecution.findMany({ where: { qcpItemId: j.stepQcp.get(j.step(2))!, unitId: j.units[0].id } });
      expect(exec.map((e) => [e.result, e.clearedBy])).toEqual([["ACCEPTED", qc.userId]]);
      expect(await planStatus(j.plan("20", 0))).toBe("COMPLETE");
    });

    it("AUD-004: an external blocking party keeps the hold point open; the step completes, the plan does not", async () => {
      const j = await inspectionJob(sup);
      const itemId = j.stepQcp.get(j.step(2))!;
      const item = await owner.qcpItem.findUniqueOrThrow({ where: { id: itemId } });
      const tpi = await owner.inspectionParty.create({ data: { qcpTemplateId: item.qcpTemplateId, code: "CLIENT_TPI", jobId: j.job.id } });
      await owner.qcpItemPartyCode.create({
        data: { qcpItemId: itemId, inspectionPartyId: tpi.id, qcpCodeId: o.holdCode.id, jobId: j.job.id, tenantId: o.tenantId },
      });

      const r = await inspectStep(qc, j.step(2));
      expect(r.to).toBe("COMPLETE");
      expect(r.rolledUp).toEqual([]);
      expect(await owner.qcpExecution.count({ where: { qcpItemId: itemId } })).toBe(0);
      expect(await planStatus(j.plan("20", 0))).toBe("IN_PROGRESS");
    });

    it("REJECT of an INSPECTION step: IN_PROGRESS, rejection, NCR and a REJECTED QCP execution; the plan stays open", async () => {
      const j = await inspectionJob(sup);
      const r = await inspectStep(qc, j.step(2), "REJECT");
      expect(r).toMatchObject({ from: "NOT_STARTED", to: "IN_PROGRESS" });
      const exec = await owner.qcpExecution.findMany({ where: { qcpItemId: j.stepQcp.get(j.step(2))! } });
      expect(exec.map((e) => e.result)).toEqual(["REJECTED"]);
      const rej = await owner.assemblyStepRejection.findFirstOrThrow({ where: { assemblyStepId: j.step(2) } });
      expect(await owner.ncr.count({ where: { assemblyStepRejectionId: rej.id } })).toBe(1);
      expect(await planStatus(j.plan("20", 0))).toBe("IN_PROGRESS");
      // Accepting again is blocked until QC dispositions the NCR (AUD-026), same as the legacy verify.
      expect(await code(inspectStep(qc2, j.step(2)))).toBe(ERROR_CODES.NCR_NOT_DISPOSITIONED);
    });

    it("component operation: ACCEPT completes it and the plan; REJECT reopens it with an NCR", async () => {
      const spec = { processes: [{ code: "13" }], components: [{ tag: "SHELL", ops: [{ code: "CUTTING" }] }] };
      const j = await o.job(spec);
      const id = j.op("SHELL", "CUTTING");
      await work(sup, j, "DONE", [[OP, id]]);
      expect((await opRow(id)).status).toBe("SUBMITTED");
      const r = await inspect(qc, { kind: OP, targetId: id, result: "ACCEPT" });
      expect(r).toMatchObject({ from: "SUBMITTED", to: "COMPLETE", rolledUp: [{ to: "COMPLETE" }] });
      expect(await planStatus(j.plan("13", 0))).toBe("COMPLETE");

      const k = await o.job(spec);
      const kid = k.op("SHELL", "CUTTING");
      await work(sup, k, "DONE", [[OP, kid]]);
      expect(await code(inspect(supQc, { kind: OP, targetId: kid, result: "ACCEPT" }))).toBeNull(); // supQc did not submit this one
      const m = await o.job(spec);
      const mid = m.op("SHELL", "CUTTING");
      await work(supQc, m, "DONE", [[OP, mid]]);
      expect(await code(inspect(supQc, { kind: OP, targetId: mid, result: "REJECT", reason: "bad cut" }))).toBe(
        ERROR_CODES.MAKER_CHECKER_VIOLATION,
      );
      const rr = await inspect(qc, { kind: OP, targetId: mid, result: "REJECT", reason: "bad cut" });
      expect(rr).toMatchObject({ from: "SUBMITTED", to: "IN_PROGRESS" });
      const rej = await owner.componentOperationRejection.findFirstOrThrow({ where: { componentOperationId: mid } });
      expect([rej.detail, await owner.ncr.count({ where: { componentOperationRejectionId: rej.id } })]).toEqual(["bad cut", 1]);
    });

    it("a submitted, non-derived JOB-grain plan: ACCEPT verifies it, REJECT sends it back with the reason", async () => {
      const j = await o.job({ processes: [{ code: "5", grain: "JOB" }, { code: "6", grain: "JOB" }] });
      for (const code of ["5", "6"]) {
        await owner.processPlan.update({ where: { id: j.plan(code) }, data: { status: "SUBMITTED", submittedBy: sup.userId } });
      }
      expect(await code(inspect(supQc, { kind: P, targetId: j.plan("5"), result: "ACCEPT" }))).toBeNull(); // submitter was sup, not supQc
      expect(await planStatus(j.plan("5"))).toBe("COMPLETE");
      const r = await inspect(qc, { kind: P, targetId: j.plan("6"), result: "REJECT", reason: "wrong sheet" });
      expect(r).toMatchObject({ from: "SUBMITTED", to: "IN_PROGRESS" });
    });
  });

  // ── leanFloor switch on the legacy paths ────────────────────────────────
  describe("leanFloor switch: DERIVED_STATUS on legacy process start/submit/verify/hold", () => {
    type Legacy = "start" | "submit" | "verify" | "hold";
    const call = (what: Legacy, j: WorkJob, id: number) =>
      ({
        start: () => startProcess(sup, { processPlanId: id }),
        submit: () => submitProcess(sup, { processPlanId: id }),
        verify: () => verifyProcess(qc, { processPlanId: id }),
        hold: () => holdProcess(sup, { processPlanId: id, reason: "waiting on drawing" }),
      })[what]();
    const prepared: Record<Legacy, { status: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED"; off: string | null }> = {
      start: { status: "NOT_STARTED", off: null },
      submit: { status: "IN_PROGRESS", off: ERROR_CODES.COMPONENT_OPS_INCOMPLETE }, // the mapped step is not complete
      verify: { status: "SUBMITTED", off: null },
      hold: { status: "IN_PROGRESS", off: null },
    };

    it.each(Object.keys(prepared) as Legacy[])("%s on a derived plan: DERIVED_STATUS with the switch on, the legacy outcome with it off", async (what) => {
      const { status, off } = prepared[what];
      const prep = async () => {
        const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }] });
        await owner.processPlan.update({
          where: { id: j.plan("20", 0) },
          data: { status, submittedBy: status === "SUBMITTED" ? sup.userId : null },
        });
        return j;
      };

      process.env.LEAN_FLOOR = "on";
      const on = await prep();
      expect(await code(call(what, on, on.plan("20", 0)))).toBe(ERROR_CODES.DERIVED_STATUS);
      expect(await planStatus(on.plan("20", 0))).toBe(status);

      delete process.env.LEAN_FLOOR;
      const offJob = await prep();
      expect(await code(call(what, offJob, offJob.plan("20", 0)))).toBe(off);
    });

    it("an unmapped plan and a JOB-grain plan are not derived: start works with the switch on", async () => {
      process.env.LEAN_FLOOR = "on";
      const j = await o.job({ processes: [{ code: "22" }, { code: "5", grain: "JOB" }], steps: [{ seq: 1, processSeq: 20 }] });
      expect(await code(startProcess(sup, { processPlanId: j.plan("22", 0) }))).toBeNull();
      expect(await code(startProcess(sup, { processPlanId: j.plan("5") }))).toBeNull();
    });

    it("legacy step start/submit/verify keep a derived plan up to date with the switch on, and leave it alone with it off", async () => {
      const spec = { processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }] };
      process.env.LEAN_FLOOR = "on";
      const on = await o.job(spec);
      const id = on.step(1);
      await startAssemblyStep(sup, { assemblyStepId: id });
      expect(await planStatus(on.plan("20", 0))).toBe("IN_PROGRESS");
      await submitAssemblyStep(sup, { assemblyStepId: id });
      await verifyAssemblyStep(qc, { assemblyStepId: id });
      expect(await planStatus(on.plan("20", 0))).toBe("COMPLETE");

      delete process.env.LEAN_FLOOR;
      const off = await o.job(spec);
      await startAssemblyStep(sup, { assemblyStepId: off.step(1) });
      await submitAssemblyStep(sup, { assemblyStepId: off.step(1) });
      await verifyAssemblyStep(qc, { assemblyStepId: off.step(1) });
      expect((await stepRow(off.step(1))).status).toBe("COMPLETE");
      expect(await planStatus(off.plan("20", 0))).toBe("NOT_STARTED");
    });

    it("legacy step reject rolls the plan up with the switch on, not with it off", async () => {
      const spec = { processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }] };
      const submitted = async () => {
        const j = await o.job(spec);
        await owner.assemblyStep.update({
          where: { id: j.step(1) },
          data: { status: "SUBMITTED", submittedBy: sup.userId, startedAt: new Date() },
        });
        return j;
      };
      process.env.LEAN_FLOOR = "on";
      const on = await submitted();
      await rejectAssemblyStep(qc, { assemblyStepId: on.step(1), categoryId: reworkCategoryId, detail: "x" });
      expect(await planStatus(on.plan("20", 0))).toBe("IN_PROGRESS");

      delete process.env.LEAN_FLOOR;
      const off = await submitted();
      await rejectAssemblyStep(qc, { assemblyStepId: off.step(1), categoryId: reworkCategoryId, detail: "x" });
      expect(await planStatus(off.plan("20", 0))).toBe("NOT_STARTED");
    });

    it("legacy operation start/submit/verify roll the plan up with the switch on", async () => {
      process.env.LEAN_FLOOR = "on";
      const j = await o.job({ processes: [{ code: "13" }], components: [{ tag: "SHELL", ops: [{ code: "CUTTING" }] }] });
      const id = j.op("SHELL", "CUTTING");
      await startComponentOperation(sup, { componentOperationId: id });
      expect(await planStatus(j.plan("13", 0))).toBe("IN_PROGRESS");
      await submitComponentOperation(sup, { componentOperationId: id });
      await verifyComponentOperation(qc, { componentOperationId: id });
      expect(await planStatus(j.plan("13", 0))).toBe("COMPLETE");

      const k = await o.job({ processes: [{ code: "13" }], components: [{ tag: "SHELL", ops: [{ code: "CUTTING" }] }] });
      await owner.componentOperation.update({
        where: { id: k.op("SHELL", "CUTTING") },
        data: { status: "SUBMITTED", submittedBy: sup.userId, startedAt: new Date() },
      });
      await rejectComponentOperation(qc, { componentOperationId: k.op("SHELL", "CUTTING"), categoryId: reworkCategoryId });
      expect(await planStatus(k.plan("13", 0))).toBe("IN_PROGRESS");
    });

    it("legacy QCP execution clears the H point and completes the plan with the switch on, not with it off", async () => {
      const ready = async () => {
        const j = await holdJob();
        await owner.assemblyStep.updateMany({
          where: { id: { in: [j.step(1), j.step(2)] } },
          data: { status: "COMPLETE", startedAt: new Date(), finishedAt: new Date() },
        });
        await owner.processPlan.update({ where: { id: j.plan("20", 0) }, data: { status: "IN_PROGRESS" } });
        return j;
      };
      const clear = (j: WorkJob) =>
        recordQcpExecution(qc, { qcpItemId: j.stepQcp.get(j.step(2))!, unitId: j.units[0].id, result: "ACCEPTED" });

      process.env.LEAN_FLOOR = "on";
      const on = await ready();
      await clear(on);
      expect(await planStatus(on.plan("20", 0))).toBe("COMPLETE");

      delete process.env.LEAN_FLOOR;
      const off = await ready();
      await clear(off);
      expect(await planStatus(off.plan("20", 0))).toBe("IN_PROGRESS");
    });
  });

  // ── the unit lock on the QC writers ─────────────────────────────────────
  describe("QC writers wait for the unit's floor lock", () => {
    /** Holds the unit's advisory lock on its own connection; `run` must not settle until it is released. */
    async function blockedWhileLocked<T>(unitId: number, run: () => Promise<T>): Promise<T> {
      let release!: () => void;
      let held!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const gotLock = new Promise<void>((r) => (held = r));
      const holder = owner.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FLOOR_LOCK_UNIT}::int, ${unitId}::int)`;
          held();
          await gate;
        },
        { timeout: 20_000 },
      );
      await gotLock;
      let settled = false;
      const p = run().finally(() => {
        settled = true;
      });
      p.catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const early = settled;
      release();
      await holder;
      const out = await p;
      expect(early, "the writer must wait for the unit lock").toBe(false);
      return out;
    }

    it("inspect (ACCEPT and REJECT), a legacy step reject, a legacy operation reject, recordQcpExecution and dispositionNcr", async () => {
      // inspect on a step and on an operation
      const a = await submittedStep(sup);
      await blockedWhileLocked(a.units[0].id, () => inspectStep(qc, a.step(1)));
      expect((await stepRow(a.step(1))).status).toBe("COMPLETE");

      const c = await o.job({ processes: [{ code: "13" }], components: [{ tag: "SHELL", ops: [{ code: "CUTTING" }] }] });
      await work(sup, c, "DONE", [[OP, c.op("SHELL", "CUTTING")]]);
      await blockedWhileLocked(c.units[0].id, () =>
        inspect(qc, { kind: OP, targetId: c.op("SHELL", "CUTTING"), result: "REJECT", reason: "bad cut" }),
      );
      expect((await opRow(c.op("SHELL", "CUTTING"))).status).toBe("IN_PROGRESS");

      // legacy rejects
      const d = await submittedStep(sup);
      await blockedWhileLocked(d.units[0].id, () =>
        rejectAssemblyStep(qc, { assemblyStepId: d.step(1), categoryId: reworkCategoryId, detail: "x" }),
      );
      expect((await stepRow(d.step(1))).status).toBe("IN_PROGRESS");

      const e = await o.job({ processes: [{ code: "13" }], components: [{ tag: "SHELL", ops: [{ code: "CUTTING" }] }] });
      await work(sup, e, "DONE", [[OP, e.op("SHELL", "CUTTING")]]);
      await blockedWhileLocked(e.units[0].id, () =>
        rejectComponentOperation(qc, { componentOperationId: e.op("SHELL", "CUTTING"), categoryId: reworkCategoryId }),
      );

      // recordQcpExecution
      const f = await inspectionJob(sup);
      const exec = await blockedWhileLocked(f.units[0].id, () =>
        recordQcpExecution(qc, { qcpItemId: f.stepQcp.get(f.step(2))!, unitId: f.units[0].id, result: "ACCEPTED" }),
      );
      expect(exec.result).toBe("ACCEPTED");

      // dispositionNcr: the NCR opened by d's reject
      const rej = await owner.assemblyStepRejection.findFirstOrThrow({ where: { assemblyStepId: d.step(1) } });
      const ncr = await owner.ncr.findFirstOrThrow({ where: { assemblyStepRejectionId: rej.id } });
      const done = await blockedWhileLocked(d.units[0].id, () => dispositionNcr(qc, { ncrId: ncr.id, disposition: "REWORK" }));
      expect(done.status).toBe("REWORK_IN_PROGRESS");
    });

    it("a different unit's lock does not block", async () => {
      const a = await submittedStep(sup);
      const other = await submittedStep(sup);
      let release!: () => void;
      let held!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const gotLock = new Promise<void>((r) => (held = r));
      const holder = owner.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FLOOR_LOCK_UNIT}::int, ${other.units[0].id}::int)`;
          held();
          await gate;
        },
        { timeout: 20_000 },
      );
      await gotLock;
      try {
        expect((await inspectStep(qc, a.step(1))).to).toBe("COMPLETE");
      } finally {
        release();
        await holder;
      }
    });
  });
});
