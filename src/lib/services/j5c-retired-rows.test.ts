import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { isAppError } from "@/lib/shared/errors";
import type { WorkOrg } from "./work.test-util";

/**
 * J5c PR 1: retired and review-flagged floor rows (a later PR makes the re-release that creates them; here the rows are
 * retired or flagged straight on the owner client). Refusals first, then what every reader and the roll-up do with them.
 * // ponytail: no cleanup of fixtures: disposable test DB, per-run org codes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("J5c retired and flagged floor rows (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withJob, withTenant } = await import("@/lib/db");
  const { makeWorkOrg } = await import("./work.test-util");
  const { recordWork, inspect } = await import("./work.service");
  const { startAssemblyStep } = await import("./assembly.service");
  const { startComponentOperation, linkGoverningDrawing } = await import("./component.service");
  const { raiseRuleNcr } = await import("./ncr.service");
  const { pickHeatNumber } = await import("./heat.service");
  const { loadFloorFacts, rowKey } = await import("./work.facts");
  const { rollupProcessPlan, loadMappedOps, assertComponentOpsComplete, assertKitReady } = await import("./_shared");
  const { loadFloorUnit } = await import("./floor.read");
  const { lineBomItemIds } = await import("./bom-line");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let sup: Actor;
  let head: Actor;
  let qc: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "J5C");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    qc = await o.user("qc", ["QC"]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  /** One unit: process 13 backed by steps 1 and 2 and the SHELL part's CUTTING operation (all rolled into 13). */
  const mk = () =>
    o.job({
      processes: [{ code: "13" }],
      steps: [{ seq: 1, processSeq: 13 }, { seq: 2, processSeq: 13 }, { seq: 3, processSeq: 13 }],
      components: [{ tag: "SHELL", pressure: true, ops: [{ code: "CUTTING" }] }],
    });
  const retire = { retiredAt: new Date(), retiredReason: "removed in BOM rev 2" };
  const setStep = (id: number, data: object) => owner.assemblyStep.update({ where: { id }, data });
  const setOp = (id: number, data: object) => owner.componentOperation.update({ where: { id }, data });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? e.code : String(e);
    }
    return null;
  };

  describe("a retired row refuses every write with FLOOR_ROW_RETIRED", () => {
    it.each([
      ["START", "ASSEMBLY_STEP"],
      ["DONE", "ASSEMBLY_STEP"],
      ["START", "COMPONENT_OP"],
      ["DONE", "COMPONENT_OP"],
    ] as const)("recordWork %s on a retired %s: refused per item, the live item of the batch applies, nothing changes", async (action, kind) => {
      const j = await mk();
      const retiredId = kind === "ASSEMBLY_STEP" ? j.step(1) : j.op("SHELL", "CUTTING");
      if (kind === "ASSEMBLY_STEP") await setStep(retiredId, { ...retire, ...(action === "DONE" ? { status: "IN_PROGRESS", startedAt: new Date() } : {}) });
      else await setOp(retiredId, { ...retire, ...(action === "DONE" ? { status: "IN_PROGRESS", startedAt: new Date() } : {}) });
      const live = kind === "ASSEMBLY_STEP" ? j.step(2) : j.step(1);
      if (action === "DONE") await setStep(live, { status: "IN_PROGRESS", startedAt: new Date() });
      const r = await recordWork(head, { jobId: j.job.id, action, items: [{ kind, id: retiredId }, { kind: "ASSEMBLY_STEP", id: live }] });
      expect(r.refused.find((x) => x.id === retiredId && x.kind === kind)).toMatchObject({ code: "FLOOR_ROW_RETIRED" });
      expect(r.applied.map((a) => a.id)).toContain(live);
      const row = kind === "ASSEMBLY_STEP" ? await owner.assemblyStep.findUniqueOrThrow({ where: { id: retiredId } }) : await owner.componentOperation.findUniqueOrThrow({ where: { id: retiredId } });
      expect(row.status).toBe(action === "DONE" ? "IN_PROGRESS" : "NOT_STARTED");
    });

    it("the legacy start paths, inspect, rule NCR, help request and drawing link refuse a retired row", async () => {
      const j = await mk();
      const stepId = j.step(1);
      const opId = j.op("SHELL", "CUTTING");
      const compId = j.components.get("SHELL:0")!;
      await setStep(stepId, retire);
      await setOp(opId, retire);
      await owner.component.update({ where: { id: compId }, data: retire });
      expect(await code(startAssemblyStep(sup, { assemblyStepId: stepId }))).toBe("FLOOR_ROW_RETIRED");
      expect(await code(startComponentOperation(sup, { componentOperationId: opId }))).toBe("FLOOR_ROW_RETIRED");
      expect(await code(inspect(qc, { kind: "ASSEMBLY_STEP", targetId: stepId, result: "ACCEPT" }))).toBe("FLOOR_ROW_RETIRED");
      expect(await code(inspect(qc, { kind: "COMPONENT_OP", targetId: opId, result: "ACCEPT" }))).toBe("FLOOR_ROW_RETIRED");
      expect(await code(raiseRuleNcr(qc, { kind: "ASSEMBLY_STEP", targetId: stepId, rule: "H5" }))).toBe("FLOOR_ROW_RETIRED");
      expect(await code(raiseRuleNcr(qc, { kind: "COMPONENT_OP", targetId: opId, rule: "H6" }))).toBe("FLOOR_ROW_RETIRED");
      expect(await code(pickHeatNumber(head, { componentId: compId, stockLotId: 1 }))).toBe("FLOOR_ROW_RETIRED");
      expect(await code(linkGoverningDrawing(head, { componentId: compId, assemblyDrawingId: null }))).toBe("FLOOR_ROW_RETIRED");
      const step = await owner.assemblyStep.findUniqueOrThrow({ where: { id: stepId } });
      expect(step.status).toBe("NOT_STARTED");
    });
  });

  describe("readers", () => {
    it("floor facts never list a retired row, and a unit whose steps are all retired has no assembly sequence", async () => {
      const j = await mk();
      await setStep(j.step(2), retire);
      await setOp(j.op("SHELL", "CUTTING"), retire);
      const facts = await withJob(o.tenantId, j.job.id, (tx) => loadFloorFacts(tx, { id: j.job.id, familyId: j.job.familyId }, j.units[0].id));
      expect(facts.rows.has(rowKey("ASSEMBLY_STEP", j.step(2)))).toBe(false);
      expect(facts.rows.has(rowKey("COMPONENT_OP", j.op("SHELL", "CUTTING")))).toBe(false);
      expect(facts.rows.has(rowKey("ASSEMBLY_STEP", j.step(1)))).toBe(true);
      for (const s of [1, 3]) await setStep(j.step(s), retire);
      const none = await withJob(o.tenantId, j.job.id, (tx) => loadFloorFacts(tx, { id: j.job.id, familyId: j.job.familyId }, j.units[0].id));
      expect(none.facts.hasAssemblySequence).toBe(false);
    });

    it("the Floor screen lists the live rows only", async () => {
      const j = await mk();
      await setStep(j.step(2), retire);
      const view = await loadFloorUnit(head, j.units[0].publicId);
      const keys = JSON.stringify(view);
      expect(keys).toContain(`ASSEMBLY_STEP:${j.step(1)}`);
      expect(keys).not.toContain(`ASSEMBLY_STEP:${j.step(2)}`);
    });

    it("the previous-step gate skips a retired step: the nearest live lower seq decides", async () => {
      const j = await mk();
      await setStep(j.step(1), { status: "COMPLETE", startedAt: new Date(), finishedAt: new Date() });
      await setStep(j.step(2), retire);
      await expect(startAssemblyStep(sup, { assemblyStepId: j.step(3) })).resolves.toMatchObject({ status: "IN_PROGRESS" });
    });

    it("kit-ready counts stock received against the same line in an earlier BOM revision", async () => {
      const j = await mk();
      const comp = j.components.get("SHELL:0")!;
      const rev1 = await owner.bomRevision.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, revisionNo: 1, status: "RELEASED", releasedAt: new Date() } });
      const rev2 = await owner.bomRevision.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, revisionNo: 2, status: "DRAFT" } });
      const line = (rev: number, itemNo: number) =>
        owner.bomItem.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, bomRevisionId: rev, itemNo, partName: "Shell", sourceQty: "1", qtyPer: 1 } });
      const old = await line(rev1.id, 7);
      const current = await line(rev2.id, 7);
      const other = await line(rev2.id, 8);
      await owner.component.update({ where: { id: comp }, data: { bomItemId: current.id } });
      // not received yet: a real shortage
      expect(await code(withTenant(o.tenantId, (tx) => assertKitReady(tx, comp, o.tenantId)))).toBe("MATERIAL_NOT_AVAILABLE");
      // received against the rev-1 line: counts for the part now pointing at rev 2
      await owner.stockLot.create({ data: { jobId: j.job.id, bomItemId: old.id, location: "Y1", qty: "1" } });
      expect(await code(withTenant(o.tenantId, (tx) => assertKitReady(tx, comp, o.tenantId)))).toBeNull();
      expect((await withTenant(o.tenantId, (tx) => lineBomItemIds(tx, current.id))).sort()).toEqual([old.id, current.id].sort());
      expect(await withTenant(o.tenantId, (tx) => lineBomItemIds(tx, other.id))).toEqual([other.id]);
    });
  });

  describe("roll-up over retired and flagged rows", () => {
    const rollup = (j: Awaited<ReturnType<typeof mk>>) =>
      withJob(o.tenantId, j.job.id, (tx) => rollupProcessPlan(tx, head, j.processes.get("13")!, j.units[0].id));
    const done = { status: "COMPLETE" as const, startedAt: new Date(), finishedAt: new Date() };

    it("retired rows are ignored: the plan completes on the live rows", async () => {
      const j = await mk();
      await setStep(j.step(1), done);
      await setStep(j.step(2), done);
      await setStep(j.step(3), retire); // never started, would have held the plan
      await setOp(j.op("SHELL", "CUTTING"), done);
      expect(await rollup(j)).toMatchObject({ to: "COMPLETE" });
    });

    it.each(["step", "op"] as const)("a flagged %s holds the plan at IN_PROGRESS although everything is COMPLETE, until the flag is cleared", async (which) => {
      const j = await mk();
      for (const s of [1, 2, 3]) await setStep(j.step(s), done);
      await setOp(j.op("SHELL", "CUTTING"), done);
      if (which === "step") await setStep(j.step(2), { needsReview: true });
      else await setOp(j.op("SHELL", "CUTTING"), { needsReview: true });
      expect(await rollup(j)).toMatchObject({ to: "IN_PROGRESS" });
      const mapped = await withJob(o.tenantId, j.job.id, (tx) => loadMappedOps(tx, { jobProcessId: j.processes.get("13")!, unitId: j.units[0].id, jobId: j.job.id }));
      expect(mapped.filter((m) => m.needsReview)).toHaveLength(1);
      expect(await code(withJob(o.tenantId, j.job.id, (tx) => assertComponentOpsComplete(tx, { jobProcessId: j.processes.get("13")!, unitId: j.units[0].id, jobId: j.job.id })))).toBe("COMPONENT_OPS_INCOMPLETE");
      // reviewed: the next roll-up completes it
      if (which === "step") await setStep(j.step(2), { needsReview: false });
      else await setOp(j.op("SHELL", "CUTTING"), { needsReview: false });
      expect(await rollup(j)).toMatchObject({ to: "COMPLETE" });
    });

    it("every mapped row retired: the plan is no longer derived and a direct start is allowed (recordWork)", async () => {
      const j = await mk();
      for (const s of [1, 2, 3]) await setStep(j.step(s), retire);
      await setOp(j.op("SHELL", "CUTTING"), retire);
      expect(await rollup(j)).toBeNull();
      const mapped = await withJob(o.tenantId, j.job.id, (tx) => loadMappedOps(tx, { jobProcessId: j.processes.get("13")!, unitId: j.units[0].id, jobId: j.job.id }));
      expect(mapped).toEqual([]);
      const r = await recordWork(head, { jobId: j.job.id, action: "START", items: [{ kind: "PROCESS_PLAN", id: j.plan("13", 0) }] });
      expect(r.refused).toEqual([]);
      expect(r.applied).toHaveLength(1);
    });

    it("the same rows with nothing retired are derived: a direct start is refused DERIVED_STATUS", async () => {
      const j = await mk();
      const r = await recordWork(head, { jobId: j.job.id, action: "START", items: [{ kind: "PROCESS_PLAN", id: j.plan("13", 0) }] });
      expect(r.refused).toMatchObject([{ code: "DERIVED_STATUS" }]);
    });
  });

  describe("v_process_plan_percent", () => {
    it("counts live rows only, in the numerator and the denominator", async () => {
      const j = await mk();
      const pct = async () =>
        withTenant(o.tenantId, async (tx) => {
          const rows = await tx.$queryRaw<{ percent: string }[]>`SELECT percent FROM v_process_plan_percent WHERE process_plan_id = ${j.plan("13", 0)}`;
          return Number(rows[0].percent);
        });
      // 3 steps (+ the CUTTING op when its family mapping reaches the process): complete one of the steps
      const before = await pct();
      expect(before).toBe(0);
      await setStep(j.step(1), { status: "COMPLETE", startedAt: new Date(), finishedAt: new Date() });
      const one = await pct();
      expect(one).toBeGreaterThan(0);
      await setStep(j.step(3), retire);
      await setStep(j.step(2), retire);
      const live = await owner.assemblyStep.count({ where: { unitId: j.units[0].id, retiredAt: null } });
      const ops = await owner.componentOperation.count({ where: { componentId: j.components.get("SHELL:0")!, retiredAt: null } });
      expect(await pct()).toBeCloseTo(100 / (live + ops), 5);
      await setStep(j.step(1), retire);
      await setOp(j.op("SHELL", "CUTTING"), retire);
      expect(await pct()).toBe(0); // nothing live: falls back to the plan's own status
    });
  });
});
