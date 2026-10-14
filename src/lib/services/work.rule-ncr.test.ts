import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { JobSpec, WorkJob, WorkOrg } from "./work.test-util";

/**
 * Lean Core L1.2f, DB-gated: D2 H5/H6 routed to a rule NCR. Violations first
 * (who may raise, who may disposition, the DB CHECKs, tenant isolation), then
 * the REPAIR loop (refused → raise → repair reopens PWHT / hydro → weld allowed
 * → repeat → NCR closed, plans back to COMPLETE) and the CONCESSION (Production
 * Head, code clause, exempts only its own target), each for H5 and H6.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L1.2f H5/H6 rule NCRs (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withJob } = await import("@/lib/db");
  const { recordWork, inspect } = await import("./work.service");
  const { raiseRuleNcr, dispositionNcr } = await import("./ncr.service");
  const { assertUnitHasNoOpenNcr } = await import("./_shared");
  const { loadQcCockpit } = await import("./qc-cockpit.read");
  const { createDispatchBatch, addUnitToBatch } = await import("./dispatch.service");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  let sup: Actor;
  let head: Actor;
  let qc: Actor;
  let qc2: Actor;
  let bQc: Actor;
  let bHead: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "F");
    b = await makeWorkOrg(owner, "G");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    qc = await o.user("qc", ["QC"]);
    qc2 = await o.user("qc2", ["QC"]);
    bQc = await b.user("bqc", ["QC"]);
    bHead = await b.user("bhead", ["PRODUCTION_HEAD"]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const S = "ASSEMBLY_STEP" as const;
  const OP = "COMPONENT_OP" as const;
  type Kind = typeof S | typeof OP;
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
  const ncrRow = (id: number) => owner.ncr.findUniqueOrThrow({ where: { id } });
  const planStatus = async (id: number) => (await owner.processPlan.findUniqueOrThrow({ where: { id } })).status;
  const accept = (actor: Actor, id: number) => inspect(actor, { kind: S, targetId: id, result: "ACCEPT" });

  /**
   * Per rule: step 1 a pressure weld (process 20), step 2 the trigger (process
   * 21 final PWHT, an INSPECTION step QC accepts / process 27 hydro, a QC-free
   * WORK step), step 3 the late pressure fusion (H5 a weld; H6 a fit-up, which
   * is "welding" for H5/H6 but not a hydro prerequisite), plus a pressure
   * cleat weld op (component op target).
   */
  const RULES = {
    H5: {
      error: ERROR_CODES.WELD_AFTER_PWHT,
      triggerProcess: "21",
      spec: (): JobSpec => ({
        processes: [{ code: "20" }, { code: "21" }],
        steps: [
          { seq: 1, role: "WELD", jointRef: "J1", pressurePart: true, processSeq: 20 },
          { seq: 2, kind: "INSPECTION", role: "FINAL_PWHT", processSeq: 21 },
          { seq: 3, role: "WELD", jointRef: "J2", pressurePart: true, processSeq: 20 },
          { seq: 4, role: "WELD", jointRef: "J3", pressurePart: true, processSeq: 20 },
        ],
        components: [{ tag: "CLEAT", pressure: true, ops: [{ code: "WELDING" }] }],
      }),
      /** Final PWHT recorded: QC accepts the INSPECTION step directly. */
      doTrigger: (j: WorkJob) => accept(qc, j.step(2)),
    },
    H6: {
      error: ERROR_CODES.WELD_AFTER_HYDRO,
      triggerProcess: "27",
      spec: (): JobSpec => ({
        processes: [{ code: "20" }, { code: "27" }],
        steps: [
          { seq: 1, role: "WELD", jointRef: "J1", pressurePart: true, processSeq: 20 },
          { seq: 2, role: "HYDRO", processSeq: 27, requiresQc: false },
          { seq: 3, role: "FIT_UP", jointRef: "J2", pressurePart: true, processSeq: 20 },
          { seq: 4, role: "FIT_UP", jointRef: "J3", pressurePart: true, processSeq: 20 },
        ],
        components: [{ tag: "CLEAT", pressure: true, ops: [{ code: "FIT_UP" }] }],
      }),
      /** Hydro done QC-free: recordWork writes it COMPLETE (its own close hook). */
      doTrigger: async (j: WorkJob) => {
        const r = await work(sup, j, "DONE", [[S, j.step(2)]]);
        expect(r.applied, JSON.stringify(r.refused)).toMatchObject([{ to: "COMPLETE" }]);
      },
    },
  } as const;
  type Rule = keyof typeof RULES;
  const cleatOp = (j: WorkJob, rule: Rule) => j.op("CLEAT", rule === "H5" ? "WELDING" : "FIT_UP");

  /** Step 1 done and accepted, then the trigger step complete: the unit is past PWHT / hydro. */
  async function pastTrigger(rule: Rule) {
    const j = await o.job(RULES[rule].spec());
    const r = await work(sup, j, "DONE", [[S, j.step(1)]]);
    expect(r.applied, JSON.stringify(r.refused)).toMatchObject([{ to: "SUBMITTED" }]);
    await accept(qc, j.step(1));
    await RULES[rule].doTrigger(j);
    expect((await stepRow(j.step(2))).status).toBe("COMPLETE");
    expect(await planStatus(j.plan(RULES[rule].triggerProcess, 0))).toBe("COMPLETE");
    return j;
  }
  const raise = (actor: Actor, j: WorkJob, rule: Rule, kind: Kind = S, id = j.step(3)) =>
    raiseRuleNcr(actor, { kind, targetId: id, rule });

  // ── Refusals ────────────────────────────────────────────────────────────
  describe("raiseRuleNcr refusals", () => {
    it.each<[string, (j: WorkJob) => Promise<unknown>, string]>([
      ["a supervisor (only QC raises)", (j) => raise(sup, j, "H5"), ERROR_CODES.FORBIDDEN],
      ["a Production Head without QC", (j) => raise(head, j, "H5"), ERROR_CODES.FORBIDDEN],
      ["a client user", (j) => raise({ ...qc, clientId: 1 }, j, "H5"), ERROR_CODES.FORBIDDEN],
      ["another tenant's QC (the item is not found)", (j) => raise(bQc, j, "H5"), ERROR_CODES.NOT_FOUND],
      ["the wrong rule (H6 where H5 refuses)", (j) => raise(qc, j, "H6"), ERROR_CODES.VALIDATION_FAILED],
      ["a non-pressure item (no rule refuses it)", (j) => raise(qc, j, "H5", S, j.step(2)), ERROR_CODES.VALIDATION_FAILED],
    ])("%s is refused and nothing is written", async (_l, call, expected) => {
      const j = await pastTrigger("H5");
      expect(await code(call(j))).toBe(expected);
      expect(await owner.ncr.count({ where: { jobId: j.job.id } })).toBe(0);
    });

    it("before the trigger has started the rule does not refuse, so there is nothing to raise", async () => {
      const j = await o.job(RULES.H5.spec());
      expect(await code(raise(qc, j, "H5"))).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it("a second NCR while one is OPEN for the same item and rule is refused", async () => {
      const j = await pastTrigger("H5");
      await raise(qc, j, "H5");
      expect(await code(raise(qc2, j, "H5"))).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(await owner.ncr.count({ where: { jobId: j.job.id } })).toBe(1);
    });
  });

  describe("dispositionNcr refusals on a rule NCR", () => {
    it.each<[string, () => Actor, Record<string, unknown>, string]>([
      ["CONCESSION by QC (decision 1: Production Head only)", () => qc, { disposition: "CONCESSION", codeClause: "UG-99" }, ERROR_CODES.FORBIDDEN],
      ["CONCESSION without a code clause", () => head, { disposition: "CONCESSION" }, ERROR_CODES.VALIDATION_FAILED],
      ["REPAIR by the Production Head (QC repairs)", () => head, { disposition: "REPAIR" }, ERROR_CODES.FORBIDDEN],
      ["USE_AS_IS", () => qc, { disposition: "USE_AS_IS" }, ERROR_CODES.VALIDATION_FAILED],
      ["REWORK", () => qc, { disposition: "REWORK" }, ERROR_CODES.VALIDATION_FAILED],
      ["SCRAP", () => qc, { disposition: "SCRAP" }, ERROR_CODES.VALIDATION_FAILED],
      ["a supervisor", () => sup, { disposition: "REPAIR" }, ERROR_CODES.FORBIDDEN],
      ["another tenant's Production Head", () => bHead, { disposition: "CONCESSION", codeClause: "UG-99" }, ERROR_CODES.NOT_FOUND],
      ["another tenant's QC", () => bQc, { disposition: "REPAIR" }, ERROR_CODES.NOT_FOUND],
    ])("%s is refused; the NCR stays OPEN and the PWHT step is untouched", async (_l, actor, extra, expected) => {
      const j = await pastTrigger("H5");
      const ncr = await raise(qc, j, "H5");
      expect(await code(dispositionNcr(actor(), { ncrId: ncr.id, ...extra } as never))).toBe(expected);
      expect((await ncrRow(ncr.id)).status).toBe("OPEN");
      expect((await stepRow(j.step(2))).status).toBe("COMPLETE");
    });

    it("an ordinary (rejection) NCR is still QC's: the Production Head is refused, QC may concede it without a clause", async () => {
      const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }] });
      await work(sup, j, "DONE", [[S, j.step(1)]]);
      await inspect(qc, { kind: S, targetId: j.step(1), result: "REJECT", reason: "undercut", categoryId: o.category.id });
      const ncr = await owner.ncr.findFirstOrThrow({ where: { jobId: j.job.id } });
      expect(await code(dispositionNcr(head, { ncrId: ncr.id, disposition: "CONCESSION" }))).toBe(ERROR_CODES.FORBIDDEN);
      expect(await code(dispositionNcr(qc, { ncrId: ncr.id, disposition: "CONCESSION" }))).toBeNull();
    });
  });

  describe("DB CHECKs on ncrs", () => {
    /** Raw inserts on the owner connection: the constraints, not the service, refuse these. */
    async function insert(j: WorkJob, cols: Record<string, unknown>) {
      const all: Record<string, unknown> = { job_id: j.job.id, ...cols };
      const names = Object.keys(all).map((k) => `"${k}"`).join(", ");
      const values = Object.values(all)
        .map((v) => (v === "NOW" ? "now()" : typeof v === "string" ? `'${v}'` : String(v)))
        .join(", ");
      return owner.$executeRawUnsafe(`INSERT INTO ncrs (${names}) VALUES (${values})`);
    }
    const violation = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return String(e).match(/ncr_[a-z_]+/)?.[0] ?? String(e);
      }
      return null;
    };

    it.each<[string, (j: WorkJob, rejectionId: number) => Record<string, unknown>, string | null]>([
      ["no source at all", () => ({}), "ncr_exactly_one_source"],
      [
        "a rejection and a target",
        (j, rej) => ({ assembly_step_rejection_id: rej, target_assembly_step_id: j.step(3), rule_code: "H5", raised_by: qc.userId, raised_at: "NOW" }),
        "ncr_exactly_one_source",
      ],
      [
        "both targets",
        (j) => ({ target_assembly_step_id: j.step(3), target_component_operation_id: cleatOp(j, "H5"), rule_code: "H5", raised_by: qc.userId, raised_at: "NOW" }),
        "ncr_exactly_one_source",
      ],
      ["a target without its rule", (j) => ({ target_assembly_step_id: j.step(3), raised_by: qc.userId, raised_at: "NOW" }), "ncr_rule_fields_chk"],
      ["a target without who raised it", (j) => ({ target_assembly_step_id: j.step(3), rule_code: "H5", raised_at: "NOW" }), "ncr_rule_fields_chk"],
      ["a rule code on a rejection NCR", (_j, rej) => ({ assembly_step_rejection_id: rej, rule_code: "H5" }), "ncr_rule_fields_chk"],
      [
        "a concession approval without a code clause",
        (j) => ({ target_assembly_step_id: j.step(3), rule_code: "H5", raised_by: qc.userId, raised_at: "NOW", concession_approved_by_id: head.userId }),
        "ncr_concession_clause_chk",
      ],
      ["a valid rule NCR on an assembly step", (j) => ({ target_assembly_step_id: j.step(3), rule_code: "H5", raised_by: qc.userId, raised_at: "NOW" }), null],
      ["a valid rule NCR on a component operation", (j) => ({ target_component_operation_id: cleatOp(j, "H5"), rule_code: "H6", raised_by: qc.userId, raised_at: "NOW" }), null],
      ["a valid rejection NCR", (_j, rej) => ({ assembly_step_rejection_id: rej }), null],
    ])("%s", async (_l, cols, expected) => {
      const j = await o.job(RULES.H5.spec());
      const rej = await owner.assemblyStepRejection.create({
        data: { assemblyStepId: j.step(1), categoryId: o.category.id, rejectedBy: qc.userId, jobId: j.job.id },
      });
      expect(await violation(insert(j, cols(j, rej.id)))).toBe(expected);
    });
  });

  // ── REPAIR ──────────────────────────────────────────────────────────────
  describe.each<Rule>(["H5", "H6"])("%s: refused → NCR → repair → repeat → closed", (rule) => {
    it("the whole loop, with the plans following it", async () => {
      const j = await pastTrigger(rule);
      const p20 = j.plan("20", 0);
      const pTrigger = j.plan(RULES[rule].triggerProcess, 0);

      // Refused, routed to an NCR that does not exist yet.
      let r = await work(sup, j, "START", [[S, j.step(3)]]);
      expect(r.refused[0]).toMatchObject({ code: RULES[rule].error, meta: { rule, routeTo: "NCR", ncrId: null } });

      const ncr = await raise(qc, j, rule);
      expect(ncr).toMatchObject({ status: "OPEN", ruleCode: rule, targetAssemblyStepId: j.step(3), raisedBy: qc.userId });
      expect(await owner.auditLog.count({ where: { tenantId: o.tenantId, action: "ncr.raiseRule", entityId: String(ncr.id) } })).toBe(1);
      // The Production Head (concession authority) is told.
      expect(await owner.notification.count({ where: { recipientId: head.userId, type: "NCR_OPENED", entityId: ncr.id } })).toBe(1);
      // A retry now points at it.
      r = await work(sup, j, "START", [[S, j.step(3)]]);
      expect(r.refused[0]).toMatchObject({ code: RULES[rule].error, meta: { ncrId: ncr.id } });
      // Dispatch's unit gate sees the open rule NCR.
      expect(await code(withJob(o.tenantId, j.job.id, (tx) => assertUnitHasNoOpenNcr(tx, j.units[0].id, j.job.id)))).toBe(ERROR_CODES.NCR_OPEN);

      // REPAIR: the trigger step reopens (times cleared, originals in the audit row) and its plan rolls back.
      const repaired = await dispositionNcr(qc, { ncrId: ncr.id, disposition: "REPAIR", notes: "grind out and re-weld" });
      expect(repaired).toMatchObject({ status: "REWORK_IN_PROGRESS", disposition: "REPAIR" });
      expect(await stepRow(j.step(2))).toMatchObject({ status: "NOT_STARTED", startedAt: null, finishedAt: null, verifiedBy: null, submittedBy: null });
      const reopen = await owner.auditLog.findFirstOrThrow({ where: { tenantId: o.tenantId, action: "assemblyStep.reopen", entityId: String(j.step(2)) } });
      expect(reopen.before).toMatchObject({ status: "COMPLETE" });
      expect(await planStatus(pTrigger)).toBe("NOT_STARTED");

      // The weld (and the next one) is allowed now; done and accepted, but the plan waits for the NCR.
      // H6: the reopened hydro is an earlier open WORK step, so the repair weld is out of sequence (SOFT).
      r = await recordWork(sup, {
        jobId: j.job.id,
        action: "DONE",
        items: [{ kind: S, id: j.step(3) }, { kind: S, id: j.step(4) }],
        override: { category: "OTHER", note: `repair under NCR ${ncr.id}` },
      });
      expect(r.applied, JSON.stringify(r.refused)).toMatchObject([
        { id: j.step(3), to: "SUBMITTED" },
        { id: j.step(4), to: "SUBMITTED" },
      ]);
      await accept(qc2, j.step(3));
      await accept(qc2, j.step(4));
      expect(await planStatus(p20)).toBe("IN_PROGRESS");
      expect(await code(withJob(o.tenantId, j.job.id, (tx) => assertUnitHasNoOpenNcr(tx, j.units[0].id, j.job.id)))).toBe(ERROR_CODES.NCR_OPEN);

      // Repeat PWHT / hydro: the NCR closes with its rework time, and both plans complete.
      await RULES[rule].doTrigger(j);
      const closed = await ncrRow(ncr.id);
      expect(closed.status).toBe("CLOSED");
      expect(closed.reworkFinishedAt).not.toBeNull();
      expect(await planStatus(pTrigger)).toBe("COMPLETE");
      expect(await planStatus(p20)).toBe("COMPLETE");
      expect(await code(withJob(o.tenantId, j.job.id, (tx) => assertUnitHasNoOpenNcr(tx, j.units[0].id, j.job.id)))).toBeNull();
    });
  });

  // ── CONCESSION ──────────────────────────────────────────────────────────
  describe.each<Rule>(["H5", "H6"])("%s: accept per code exception", (rule) => {
    it("Production Head with a clause: audited, flagged to QC, exempts only its own target, nothing reopened", async () => {
      const j = await pastTrigger(rule);
      const ncr = await raise(qc, j, rule);
      const before = await owner.notification.count({ where: { tenantId: o.tenantId, type: "NCR_CONCESSION", entityId: ncr.id } });
      const conceded = await dispositionNcr(head, { ncrId: ncr.id, disposition: "CONCESSION", codeClause: "ASME VIII-1 UCS-56(f)" });
      expect(conceded).toMatchObject({
        status: "DISPOSITIONED",
        disposition: "CONCESSION",
        codeClause: "ASME VIII-1 UCS-56(f)",
        concessionApprovedById: head.userId,
      });
      const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: o.tenantId, action: "ncr.disposition", entityId: String(ncr.id) } });
      expect(audit.after).toMatchObject({ ruleCode: rule, codeClause: "ASME VIII-1 UCS-56(f)", ratification: "QC_HEAD_PENDING" });
      // Flagged for the QC head's ratification (no QC head role yet: every QC user).
      expect(await owner.notification.count({ where: { tenantId: o.tenantId, type: "NCR_CONCESSION", entityId: ncr.id } })).toBe(before + 2);
      expect((await stepRow(j.step(2))).status).toBe("COMPLETE");

      // The target starts; the next pressure step and the cleat op are still refused.
      const r = await work(sup, j, "START", [[S, j.step(3)], [S, j.step(4)], [OP, cleatOp(j, rule)]]);
      expect(r.applied.map((a) => a.id)).toEqual([j.step(3)]);
      expect(r.refused.map((x) => [x.id, x.code])).toEqual([
        [j.step(4), RULES[rule].error],
        [cleatOp(j, rule), RULES[rule].error],
      ]);
      // A DISPOSITIONED concession no longer blocks the unit.
      expect(await code(withJob(o.tenantId, j.job.id, (tx) => assertUnitHasNoOpenNcr(tx, j.units[0].id, j.job.id)))).toBeNull();
    });
  });

  it("a component operation target: raised, conceded, and only that operation starts", async () => {
    const j = await pastTrigger("H5");
    const ncr = await raise(qc, j, "H5", OP, cleatOp(j, "H5"));
    expect(ncr.targetComponentOperationId).toBe(cleatOp(j, "H5"));
    await dispositionNcr(head, { ncrId: ncr.id, disposition: "CONCESSION", codeClause: "UW-26" });
    const r = await work(sup, j, "START", [[OP, cleatOp(j, "H5")], [S, j.step(3)]]);
    expect(r.applied.map((a) => a.id)).toEqual([cleatOp(j, "H5")]);
    expect(r.refused.map((x) => x.code)).toEqual([ERROR_CODES.WELD_AFTER_PWHT]);
  });

  it("an H5 concession does not exempt the same item from H6", async () => {
    const j = await o.job({
      processes: [{ code: "20" }, { code: "21" }, { code: "27" }],
      steps: [
        { seq: 1, role: "WELD", jointRef: "J1", pressurePart: true, processSeq: 20 },
        { seq: 2, kind: "INSPECTION", role: "FINAL_PWHT", processSeq: 21 },
        { seq: 3, role: "HYDRO", processSeq: 27, requiresQc: false },
        { seq: 4, role: "FIT_UP", jointRef: "J2", pressurePart: true, processSeq: 20 },
      ],
    });
    await work(sup, j, "DONE", [[S, j.step(1)]]);
    await accept(qc, j.step(1));
    await accept(qc, j.step(2));
    const ncr = await raise(qc, j, "H5", S, j.step(4));
    await dispositionNcr(head, { ncrId: ncr.id, disposition: "CONCESSION", codeClause: "UG-99" });
    expect((await work(sup, j, "DONE", [[S, j.step(3)]])).applied).toMatchObject([{ to: "COMPLETE" }]);
    const r = await work(sup, j, "START", [[S, j.step(4)]]);
    expect(r.refused[0]?.code).toBe(ERROR_CODES.WELD_AFTER_HYDRO);
  });

  it("Done of a weld started before the final PWHT is refused by H5 and points at its rule NCR", async () => {
    const j = await o.job(RULES.H5.spec());
    await work(sup, j, "DONE", [[S, j.step(1)]]);
    await accept(qc, j.step(1));
    expect((await work(sup, j, "START", [[S, j.step(3)]])).applied).toHaveLength(1);
    await RULES.H5.doTrigger(j);
    let r = await work(sup, j, "DONE", [[S, j.step(3)]]);
    expect(r.refused[0]).toMatchObject({ code: ERROR_CODES.WELD_AFTER_PWHT, meta: { rule: "H5", routeTo: "NCR", ncrId: null } });
    const ncr = await raise(qc, j, "H5");
    r = await work(sup, j, "DONE", [[S, j.step(3)]]);
    expect(r.refused[0]).toMatchObject({ code: ERROR_CODES.WELD_AFTER_PWHT, meta: { routeTo: "NCR", ncrId: ncr.id } });
  });

  it("dispatch refuses a packed unit carrying an open rule NCR", async () => {
    const j = await pastTrigger("H5");
    await raise(qc, j, "H5");
    const pkg = await owner.package.create({ data: { jobId: j.job.id, packageNo: "P1", createdBy: head.userId } });
    await owner.unit.update({ where: { id: j.units[0].id }, data: { packageId: pkg.id } });
    const batch = await createDispatchBatch(head, { jobId: j.job.id, seq: 1, plannedDate: new Date() });
    expect(await code(addUnitToBatch(head, { dispatchBatchId: batch.id, unitId: j.units[0].id }))).toBe(ERROR_CODES.NCR_OPEN);
    expect(await owner.dispatchBatchUnit.count({ where: { dispatchBatchId: batch.id } })).toBe(0);
  });

  // ── QC cockpit and tenant isolation ─────────────────────────────────────
  it("the QC cockpit lists an open rule NCR for its own tenant only", async () => {
    const j = await pastTrigger("H6");
    const ncr = await raise(qc, j, "H6");
    const mine = await loadQcCockpit(qc);
    expect(mine.openNcrs.find((n) => n.ncrId === ncr.id)).toMatchObject({
      jobId: j.job.id,
      unitId: j.units[0].id,
      entityLabel: "step 3",
      categoryName: "H6 · welding after hydro",
      rejectedByName: "qc",
    });
    expect(mine.rework.openCount).toBeGreaterThanOrEqual(1);
    const theirs = await loadQcCockpit(bQc);
    expect(theirs.openNcrs.find((n) => n.ncrId === ncr.id)).toBeUndefined();
  });
});
