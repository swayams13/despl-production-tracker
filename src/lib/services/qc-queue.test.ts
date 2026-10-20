import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import { parseQcQuery, type QcQuery } from "@/lib/shared/qc-queue";

/**
 * Lean Core L2.6, DB-gated: the QC queue read model (qc-queue.read.ts) and the
 * evidence a clearing needs (qcp.service.ts recordQcpExecution under leanFloor).
 * Each case builds its own job on a throwaway org so counts are exact.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L2.6 QC queue (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadQcQueue, loadQcCounts, loadQcReadyCount, resolveQcAccess } = await import("./qc-queue.read");
  const { recordQcpExecution, approveQcpWaiver } = await import("./qcp.service");
  const { loadOpenHoldPoints, loadOpenHoldPointsBatch } = await import("./workspace.read");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  type Org = Awaited<ReturnType<typeof makeWorkOrg>>;
  let o: Org;
  let b: Org;
  let qc: Actor;
  let head: Actor;
  let mgmt: Actor;
  let sup: Actor;
  let bQc: Actor;
  let maker: Actor;
  const priorFlag = process.env.LEAN_FLOOR;
  beforeAll(async () => {
    process.env.LEAN_FLOOR = "on";
    o = await makeWorkOrg(owner, "QCQ");
    b = await makeWorkOrg(owner, "QCQB");
    qc = await o.user("qc", ["QC"]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    mgmt = await o.user("md", ["MANAGEMENT"]);
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    maker = await o.user("maker", ["OPERATOR"], [o.fab.id]);
    bQc = await b.user("bqc", ["QC"]);
  });
  afterAll(async () => {
    if (priorFlag === undefined) delete process.env.LEAN_FLOOR;
    else process.env.LEAN_FLOOR = priorFlag;
    await owner.$disconnect();
  });

  const q = (over: Partial<QcQuery> = {}): QcQuery => ({ ...parseQcQuery({}), ...over });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? e.code : `NON_APP_ERROR: ${String(e)}`;
    }
    return null;
  };
  const rowsOf = <R,>(g: Array<{ units: Array<{ rows: R[] }> }>): R[] => g.flatMap((j) => j.units.flatMap((u) => u.rows));

  describe("access", () => {
    it("QC, Production Head, Management and Admin view; QC alone inspects; others see nothing", async () => {
      expect(resolveQcAccess(qc)).toMatchObject({ view: true, inspect: true, waive: false, disposition: true, concede: false, ratify: true });
      expect(resolveQcAccess(head)).toMatchObject({ view: true, inspect: false, waive: true, disposition: false, concede: true, ratify: false });
      expect(resolveQcAccess(mgmt)).toMatchObject({ view: true, inspect: false, waive: false, disposition: false, concede: false });
      expect(resolveQcAccess(sup).view).toBe(false);
      expect(resolveQcAccess({ ...qc, clientId: 5 }).view).toBe(false);
    });
    it("a supervisor gets an empty view and zero counts, not another department's data", async () => {
      await o.job({ processes: [{ code: "20", status: "SUBMITTED" }] });
      const v = await loadQcQueue(sup, q());
      expect(v.access.view).toBe(false);
      expect(v.total).toBe(0);
      expect(await loadQcCounts(sup)).toEqual({ ready: 0, holds: 0, ncrs: 0 });
    });
  });

  describe("Ready to inspect", () => {
    it("lists SUBMITTED steps, operations and plans, and an inspection step whose preceding work is in; not the rest", async () => {
      const j = await o.job({
        units: 2,
        processes: [{ code: "20", status: "SUBMITTED" }, { code: "21" }],
        steps: [{ seq: 1 }, { seq: 2, kind: "INSPECTION" }],
        components: [{ tag: "SHELL", ops: [{ code: "CUTTING" }] }],
      });
      // Unit 0: work step submitted -> it and its inspection step are both ready. Unit 1: nothing started.
      await owner.assemblyStep.update({ where: { id: j.step(1, 0) }, data: { status: "SUBMITTED", submittedBy: maker.userId } });
      await owner.componentOperation.update({ where: { id: j.op("SHELL", "CUTTING", 0) }, data: { status: "SUBMITTED", submittedBy: maker.userId } });

      const v = await loadQcQueue(qc, q({ jobId: j.job.id }));
      const rows = rowsOf(v.ready);
      const keys = rows.map((r) => r.key).sort();
      expect(keys).toEqual(
        [
          `AS:${j.step(1, 0)}`, // submitted work
          `IN:${j.step(2, 0)}`, // its inspection, now ready
          `CO:${j.op("SHELL", "CUTTING", 0)}`,
          `PP:${j.plan("20", 0)}`,
          `PP:${j.plan("20", 1)}`,
        ].sort(),
      );
      expect(keys).not.toContain(`IN:${j.step(2, 1)}`); // unit 1's work was never recorded
      expect(v.counts.ready).toBe(5);
      expect(rows.find((r) => r.key === `IN:${j.step(2, 0)}`)).toMatchObject({ inspection: true, makerName: null });
      expect(rows.find((r) => r.key === `AS:${j.step(1, 0)}`)).toMatchObject({ inspection: false, makerName: "maker" });
    });

    it("an inspection step waits for EVERY preceding work step on its joint, and a COMPLETE one drops out", async () => {
      const j = await o.job({
        steps: [{ seq: 1, jointRef: "LS-1" }, { seq: 2, jointRef: "LS-1" }, { seq: 3, kind: "INSPECTION", jointRef: "LS-1" }],
      });
      await owner.assemblyStep.update({ where: { id: j.step(1) }, data: { status: "SUBMITTED", submittedBy: maker.userId } });
      const key = `IN:${j.step(3)}`;
      expect(rowsOf((await loadQcQueue(qc, q({ jobId: j.job.id }))).ready).map((r) => r.key)).not.toContain(key);
      await owner.assemblyStep.update({ where: { id: j.step(2) }, data: { status: "COMPLETE" } });
      expect(rowsOf((await loadQcQueue(qc, q({ jobId: j.job.id }))).ready).map((r) => r.key)).toContain(key);
      await owner.assemblyStep.update({ where: { id: j.step(3) }, data: { status: "COMPLETE" } });
      expect(rowsOf((await loadQcQueue(qc, q({ jobId: j.job.id }))).ready).map((r) => r.key)).not.toContain(key);
    });

    it("is oldest first, grouped job then unit, and filters by job and unit in SQL", async () => {
      const j = await o.job({ units: 2, steps: [{ seq: 1 }] });
      const t = (d: number) => new Date(Date.now() - d * 86_400_000);
      await owner.assemblyStep.update({ where: { id: j.step(1, 0) }, data: { status: "SUBMITTED", submittedBy: maker.userId, reportedFinishAt: t(1) } });
      await owner.assemblyStep.update({ where: { id: j.step(1, 1) }, data: { status: "SUBMITTED", submittedBy: maker.userId, reportedFinishAt: t(4) } });

      const all = await loadQcQueue(qc, q({ jobId: j.job.id }));
      expect(all.ready).toHaveLength(1); // one job
      expect(all.ready[0]!.units.map((u) => u.rows[0]!.id)).toEqual([j.step(1, 1), j.step(1, 0)]); // the 4-day-old first
      expect(rowsOf(all.ready).map((r) => r.ageDays)).toEqual([4, 1]);

      const one = await loadQcQueue(qc, q({ jobId: j.job.id, unitId: j.units[0].id }));
      expect(rowsOf(one.ready).map((r) => r.id)).toEqual([j.step(1, 0)]);
      expect(one.unitSerial).toBe(j.units[0].serialNo);
    });

    it("pages at 25 and the count is the whole list; never another tenant's rows", async () => {
      const j = await o.job({ components: [{ tag: "P", ops: Array.from({ length: 30 }, () => ({ code: "CUTTING" })) }] });
      await owner.componentOperation.updateMany({ where: { componentId: { in: [...j.components.values()] } }, data: { status: "SUBMITTED", submittedBy: maker.userId } });
      const p1 = await loadQcQueue(qc, q({ jobId: j.job.id }));
      expect(p1).toMatchObject({ total: 30, page: 1, pages: 2 });
      expect(rowsOf(p1.ready)).toHaveLength(25);
      const p2 = await loadQcQueue(qc, q({ jobId: j.job.id, page: 2 }));
      expect(rowsOf(p2.ready)).toHaveLength(5);
      expect(p1.counts.ready).toBe(30);

      // Another org's QC cannot reach it, with or without the job id.
      const other = await loadQcQueue(bQc, q({ jobId: j.job.id }));
      expect(other.counts).toEqual({ ready: 0, holds: 0, ncrs: 0 });
      expect(rowsOf(other.ready)).toEqual([]);
    });
  });

  describe("Open holds", () => {
    /** One job: process 20 (in progress), a DESPL H point on each unit's step, linked to the process. */
    async function holdJob(opts: { status?: "NOT_STARTED" | "IN_PROGRESS"; units?: number } = {}) {
      const j = await o.job({
        units: opts.units ?? 1,
        processes: [{ code: "20", status: opts.status ?? "IN_PROGRESS" }],
        steps: [{ seq: 1, hold: true, kind: "INSPECTION" }],
      });
      for (const itemId of new Set(j.stepQcp.values())) {
        await owner.qcpItemProcess.create({ data: { jobId: j.job.id, qcpItemId: itemId, jobProcessId: j.processes.get("20")! } });
      }
      return j;
    }
    const holds = async (jobId: number) => rowsOf((await loadQcQueue(qc, q({ tab: "holds", jobId }))).holds);

    it("shows a reached point as Pending and drops it once accepted", async () => {
      const j = await holdJob();
      const item = j.stepQcp.get(j.step(1))!;
      expect((await holds(j.job.id)).map((h) => [h.qcpItemId, h.status, h.classCode])).toEqual([[item, "PENDING", "H"]]);
      await recordQcpExecution(qc, { qcpItemId: item, unitId: j.units[0].id, result: "ACCEPTED" });
      expect(await holds(j.job.id)).toEqual([]);
    });

    it("a point nobody has reached is upcoming, not a hold", async () => {
      const j = await holdJob({ status: "NOT_STARTED" });
      expect(await holds(j.job.id)).toEqual([]);
      expect((await loadQcQueue(qc, q({ tab: "holds", jobId: j.job.id }))).counts.holds).toBe(0);
    });

    it("follows the gate: a rejected point reinspects; an unapproved NA is a pending waiver until the Production Head approves", async () => {
      const j = await holdJob();
      const item = j.stepQcp.get(j.step(1))!;
      const unitId = j.units[0].id;
      await recordQcpExecution(qc, { qcpItemId: item, unitId, result: "REJECTED", remarks: "porosity" });
      expect((await holds(j.job.id))[0]).toMatchObject({ status: "REINSPECT", waiverPending: false });

      // The seeded H code is not waivable; make this one waivable for the waiver path.
      await owner.qcpCodeRef.update({ where: { id: o.holdCode.id }, data: { waivable: true } });
      await recordQcpExecution(qc, { qcpItemId: item, unitId, result: "NA", remarks: "client waived" });
      expect((await holds(j.job.id))[0]).toMatchObject({ status: "WAIVER_PENDING", waiverPending: true });
      await approveQcpWaiver(head, { qcpItemId: item, unitId });
      expect(await holds(j.job.id)).toEqual([]);
      await owner.qcpCodeRef.update({ where: { id: o.holdCode.id }, data: { waivable: false } });
    });

    it("the job-level hold list and counts agree with /qc (one ladder, one scope), and an unapproved NA is open in both", async () => {
      const j = await holdJob();
      const item = j.stepQcp.get(j.step(1))!;
      const unitId = j.units[0].id;
      const agree = async () => {
        const queue = (await loadQcQueue(qc, q({ tab: "holds", jobId: j.job.id }))).counts.holds;
        const single = await loadOpenHoldPoints(qc, j.job.id);
        const batch = (await loadOpenHoldPointsBatch(qc, [j.job.id])).get(j.job.id) ?? [];
        expect([single.length, batch.length]).toEqual([queue, queue]);
        return single;
      };
      expect((await agree()).map((h) => h.status)).toEqual(["Pending"]);
      await owner.qcpCodeRef.update({ where: { id: o.holdCode.id }, data: { waivable: true } });
      try {
        await recordQcpExecution(qc, { qcpItemId: item, unitId, result: "NA", remarks: "client waived" });
        expect((await agree()).map((h) => h.status)).toEqual(["Waiver pending"]); // the old ladders called this cleared
        await approveQcpWaiver(head, { qcpItemId: item, unitId });
        expect(await agree()).toEqual([]);
      } finally {
        await owner.qcpCodeRef.update({ where: { id: o.holdCode.id }, data: { waivable: false } });
      }
    });

    it("an unreached point is upcoming in the lean floor's counts everywhere; with the switch off the job lists keep their old scope", async () => {
      const j = await holdJob({ status: "NOT_STARTED" });
      expect(await loadOpenHoldPoints(qc, j.job.id)).toEqual([]);
      expect((await loadOpenHoldPointsBatch(qc, [j.job.id])).get(j.job.id) ?? []).toEqual([]);
      process.env.LEAN_FLOOR = "off";
      try {
        expect((await loadOpenHoldPoints(qc, j.job.id)).map((h) => h.status)).toEqual(["Pending"]); // today's behaviour
      } finally {
        process.env.LEAN_FLOOR = "on";
      }
    });

    it("sorts H before W whatever the age, and counts match the list", async () => {
      const j = await holdJob({ units: 2 });
      const wCode = await owner.qcpCodeRef.create({ data: { tenantId: o.tenantId, code: `W${o.uniq("c")}`, label: "Witness", blocksCompletion: true } });
      // Re-class unit-agnostic item 2 as W by adding a second item.
      const party = await owner.inspectionParty.findFirstOrThrow({ where: { jobId: j.job.id } });
      const tpl = await owner.qcpTemplate.findFirstOrThrow({ where: { jobId: j.job.id } });
      const wItem = await owner.qcpItem.create({
        data: { qcpTemplateId: tpl.id, sequence: 99, srNo: "99", kind: "CHECKPOINT", activity: "witness point", jobId: j.job.id },
      });
      await owner.qcpItemPartyCode.create({ data: { qcpItemId: wItem.id, inspectionPartyId: party.id, qcpCodeId: wCode.id, jobId: j.job.id } });
      await owner.qcpItemProcess.create({ data: { jobId: j.job.id, qcpItemId: wItem.id, jobProcessId: j.processes.get("20")! } });
      // Make the W point the oldest by a recorded attempt long ago.
      await owner.qcpExecution.create({
        data: { qcpItemId: wItem.id, unitId: j.units[0].id, result: "PENDING", jobId: j.job.id, recordedAt: new Date(Date.now() - 20 * 86_400_000) },
      });

      // The fixture makes one H point per unit and every point expands over both units: 2 H x 2 + 1 W x 2.
      const v = await loadQcQueue(qc, q({ tab: "holds", jobId: j.job.id }));
      const list = rowsOf(v.holds);
      expect(list).toHaveLength(6);
      expect(v.counts.holds).toBe(6);
      // Within each unit group the class order holds, whatever the W point's age.
      for (const u of v.holds[0]!.units) expect(u.rows.map((h) => h.classCode)).toEqual(["H", "H", wCode.code]);
      expect(list.find((h) => h.classCode === wCode.code && h.unitId === j.units[0].id)!.ageDays).toBeGreaterThanOrEqual(20);
    });
  });

  describe("evidence on clearing (§8.2 item 18)", () => {
    async function pointJob(opts: { activity: string; external: boolean }) {
      const j = await o.job({ processes: [{ code: "20", status: "IN_PROGRESS" }], steps: [{ seq: 1, hold: true, kind: "INSPECTION" }] });
      const item = j.stepQcp.get(j.step(1))!;
      await owner.qcpItem.update({ where: { id: item }, data: { activity: opts.activity } });
      await owner.qcpItemProcess.create({ data: { jobId: j.job.id, qcpItemId: item, jobProcessId: j.processes.get("20")! } });
      if (opts.external) {
        const tpl = await owner.qcpTemplate.findFirstOrThrow({ where: { jobId: j.job.id } });
        const tpi = await owner.inspectionParty.create({ data: { qcpTemplateId: tpl.id, code: "CLIENT_TPI", name: "Client TPI", jobId: j.job.id } });
        await owner.qcpItemPartyCode.create({ data: { qcpItemId: item, inspectionPartyId: tpi.id, qcpCodeId: o.holdCode.id, jobId: j.job.id } });
      }
      return { j, item, unitId: j.units[0].id };
    }

    it("DESPL's own, non-test point clears with no evidence", async () => {
      const { item, unitId } = await pointJob({ activity: "Visual inspection", external: false });
      expect(await code(recordQcpExecution(qc, { qcpItemId: item, unitId, result: "ACCEPTED" }))).toBeNull();
    });

    it("a third party's point needs the inspector and the report number, and stores both", async () => {
      const { j, item, unitId } = await pointJob({ activity: "RT of nozzle weld", external: true });
      expect((await holds(j.job.id))[0]).toMatchObject({ external: true, parties: expect.stringContaining("Client TPI") });

      expect(await code(recordQcpExecution(qc, { qcpItemId: item, unitId, result: "ACCEPTED" }))).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(await code(recordQcpExecution(qc, { qcpItemId: item, unitId, result: "ACCEPTED", partyInspector: "A. Rao" }))).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(await owner.qcpExecution.count({ where: { qcpItemId: item } })).toBe(0); // nothing written by a refusal

      await recordQcpExecution(qc, { qcpItemId: item, unitId, result: "ACCEPTED", partyInspector: "A. Rao", reportRef: "IRN-2231" });
      const e = await owner.qcpExecution.findFirstOrThrow({ where: { qcpItemId: item } });
      expect(e).toMatchObject({ result: "ACCEPTED", clearedByPartyRef: "A. Rao", reportRef: "IRN-2231", clearedBy: qc.userId });
    });

    it("a rejection never needs evidence", async () => {
      const { item, unitId } = await pointJob({ activity: "RT of nozzle weld", external: true });
      expect(await code(recordQcpExecution(qc, { qcpItemId: item, unitId, result: "REJECTED", remarks: "film unreadable" }))).toBeNull();
    });

    it("a hydro point needs pressure, hold time and gauge ids, stored as given", async () => {
      const { item, unitId } = await pointJob({ activity: "Hydrostatic test", external: false });
      expect(await code(recordQcpExecution(qc, { qcpItemId: item, unitId, result: "ACCEPTED" }))).toBe(ERROR_CODES.VALIDATION_FAILED);
      await recordQcpExecution(qc, {
        qcpItemId: item,
        unitId,
        result: "ACCEPTED",
        testData: { pressureBar: 22.5, holdMinutes: 30, gaugeIds: ["PG-101", "PG-102"] },
      });
      const e = await owner.qcpExecution.findFirstOrThrow({ where: { qcpItemId: item } });
      expect(e.testData).toEqual({ pressureBar: 22.5, holdMinutes: 30, gaugeIds: ["PG-101", "PG-102"] });
    });

    it("is not asked while the lean switch is off (the legacy cockpit sends no evidence)", async () => {
      const { item, unitId } = await pointJob({ activity: "Hydrostatic test", external: true });
      process.env.LEAN_FLOOR = "off";
      try {
        expect(await code(recordQcpExecution(qc, { qcpItemId: item, unitId, result: "ACCEPTED" }))).toBeNull();
      } finally {
        process.env.LEAN_FLOOR = "on";
      }
    });

    async function holds(jobId: number) {
      return rowsOf((await loadQcQueue(qc, q({ tab: "holds", jobId }))).holds);
    }
  });

  describe("NCRs", () => {
    it("lists open NCRs oldest first, drops CLOSED ones, and marks a concession awaiting ratification", async () => {
      const j = await o.job({ steps: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] });
      const mk = (stepSeq: number, data: Record<string, unknown>) =>
        owner.ncr.create({
          data: {
            jobId: j.job.id,
            ruleCode: "H5",
            targetAssemblyStepId: j.step(stepSeq),
            raisedBy: maker.userId,
            raisedAt: new Date(Date.now() - (4 - stepSeq) * 86_400_000),
            ...data,
          } as never,
        });
      const open = await mk(1, { status: "OPEN" });
      const conc = await mk(2, { status: "DISPOSITIONED", disposition: "CONCESSION", concessionApprovedById: head.userId, codeClause: "UG-99" });
      await mk(3, { status: "CLOSED", closedBy: head.userId, closedAt: new Date() });

      const v = await loadQcQueue(qc, q({ tab: "ncrs", jobId: j.job.id }));
      const rows = rowsOf(v.ncrs);
      expect(rows.map((r) => r.ncrId)).toEqual([open.id, conc.id]); // oldest first, closed absent
      expect(rows[0]).toMatchObject({ status: "OPEN", awaitingRatification: false, categoryName: "H5 · welding after final PWHT", raisedByName: "maker" });
      expect(rows[1]).toMatchObject({ awaitingRatification: true, concessionBy: head.userId });
      expect(rows.map((r) => r.ruleNcr)).toEqual([true, true]); // both are H5 rule NCRs: the Production Head may accept them as a concession
      expect(v.counts.ncrs).toBe(2);
      expect((await loadQcQueue(bQc, q({ tab: "ncrs", jobId: j.job.id }))).counts.ncrs).toBe(0);
    });
  });

  it("counts match the list for the same scope, whichever way they are asked", async () => {
    const j = await o.job({ processes: [{ code: "20", status: "SUBMITTED" }], components: [{ tag: "C", ops: [{ code: "CUTTING" }] }] });
    await owner.componentOperation.updateMany({ where: { componentId: { in: [...j.components.values()] } }, data: { status: "SUBMITTED" } });
    const via = await loadQcCounts(qc, { jobId: j.job.id });
    const page = await loadQcQueue(qc, q({ jobId: j.job.id }));
    expect(via).toEqual(page.counts);
    expect(via.ready).toBe(2);
    // The nav badge is the same Ready list, tenant-wide: at least this job's two.
    expect(await loadQcReadyCount(qc)).toBeGreaterThanOrEqual(2);
    expect(await loadQcReadyCount(sup)).toBe(0);
  });
});
