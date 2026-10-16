import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * Lean Core L2.4, DB-gated: the Job board read model (board.read.ts), the
 * Stage Sheet's cell detail (board.cell.read.ts) and the tracker export rows
 * (board.export.read.ts). Scoping first, then values, then the sheet.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L2.4 job board (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadJobBoard } = await import("./board.read");
  const { loadBoardCell } = await import("./board.cell.read");
  const { loadTrackerSheet } = await import("./board.export.read");
  const { recordWork } = await import("./work.service");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  type Org = Awaited<ReturnType<typeof makeWorkOrg>>;
  let o: Org;
  let b: Org;
  let sup: Actor;
  let qc: Actor;
  let bSup: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "BRD");
    b = await makeWorkOrg(owner, "BRB");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    qc = await o.user("qc", ["QC"], [o.fab.id]);
    bSup = await b.user("bsup", ["SUPERVISOR"], [b.fab.id]);
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
  const S = "ASSEMBLY_STEP" as const;

  /** Two units; stage 10 complete, 11 in progress on SR1 / not started on SR2, 12 overdue. */
  async function fixture() {
    const past = new Date(Date.now() - 4 * 86_400_000);
    const j = await o.job({
      units: 2,
      processes: [
        { code: "20", stages: [10], status: "COMPLETE" },
        { code: "21", stages: [11] },
        { code: "22", stages: [12], plannedFinish: past },
      ],
      steps: [
        { seq: 1, processSeq: 21, requiresQc: false },
        { seq: 2, processSeq: 21, requiresQc: false },
        { seq: 3, processSeq: 21 },
      ],
    });
    // SR1: one of three stage-11 steps done (QC-free), and mark its plan in progress.
    await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: S, id: j.step(1, 0) }] });
    await owner.processPlan.update({ where: { id: j.plan("21", 0) }, data: { status: "IN_PROGRESS" } });
    return j;
  }

  describe("loadJobBoard", () => {
    it("prints the value of every cell and totals the units done per stage", async () => {
      const j = await fixture();
      const v = (await loadJobBoard(sup, j.job.id))!;
      expect(v.units.map((u) => u.serialNo)).toHaveLength(2);
      const [sr1, sr2] = v.units;

      expect(sr1.cells[10]).toMatchObject({ status: "complete", hasPlans: true });
      expect(sr1.cells[11]).toMatchObject({ status: "progress", value: "1/3" });
      expect(sr2.cells[11]).toMatchObject({ status: "idle", value: "not sch." });
      expect(sr1.cells[12]).toMatchObject({ status: "overdue" });
      expect(sr1.cells[12].value).toMatch(/^\+\dd$/);

      const stage10 = v.stages.find((s) => s.stageNo === 10)!;
      expect(stage10).toMatchObject({ done: 2, total: 2 });
      expect(v.stages.find((s) => s.stageNo === 11)).toMatchObject({ done: 0, total: 2 });
      expect(sr1.currentStage?.stageNo).toBe(11);
      expect(v.counts.overdue).toBe(2);
    });

    it("a stage no process backs on a unit is a dash, not a status", async () => {
      const j = await o.job({ processes: [{ code: "20", stages: [10] }, { code: "21", stages: [] }], steps: [{ seq: 1, processSeq: 20 }] });
      const v = (await loadJobBoard(sup, j.job.id))!;
      expect(v.stages.map((s) => s.stageNo)).toEqual(expect.arrayContaining([10]));
      expect(v.units[0].cells[10].hasPlans).toBe(true);
    });

    it("flags a cell out of sequence when an item in it carries an override", async () => {
      const j = await fixture();
      await owner.sequenceOverride.create({
        data: { jobId: j.job.id, targetKind: "ASSEMBLY_STEP", targetId: j.step(2, 0), unitId: j.units[0].id, category: "CLIENT_PRIORITY", createdBy: sup.userId },
      });
      const v = (await loadJobBoard(sup, j.job.id))!;
      expect(v.units[0].cells[11].outOfSequence).toBe(true);
      expect(v.units[1].cells[11].outOfSequence).toBe(false);
      expect(v.counts.outOfSequence).toBe(1);
    });

    it.each<[string, () => Promise<unknown>]>([
      ["another tenant's job is not found", async () => loadJobBoard(bSup, (await fixture()).job.id)],
    ])("%s", async (_l, call) => {
      expect(await call()).toBeNull();
    });

    it("a client user is refused", async () => {
      const j = await fixture();
      expect(await code(loadJobBoard({ ...sup, clientId: 1 }, j.job.id))).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  describe("loadBoardCell", () => {
    it("lists the steps of the stage with who, recorded time and the viewer's action", async () => {
      const j = await fixture();
      const c = (await loadBoardCell(sup, j.job.id, j.units[0].id, 11))!;
      expect(c.items.map((i) => i.title)).toEqual(["step 1", "step 2", "step 3"]);
      const done = c.items.find((i) => i.title === "step 1")!;
      expect(done).toMatchObject({ status: "COMPLETE", who: expect.any(String) });
      expect(done.finishedAt).not.toBeNull();
      expect(c.items.find((i) => i.title === "step 2")!.floor).not.toBeNull(); // supervisor can act
      expect(c.items.every((i) => !i.canInspect)).toBe(true);
      expect(c.canRecord).toBe(true);
    });

    it("QC may inspect submitted work only, and cannot record", async () => {
      const j = await fixture();
      await owner.assemblyStep.update({ where: { id: j.step(3, 0) }, data: { status: "SUBMITTED", submittedBy: sup.userId } }); // QC-required work, done
      const c = (await loadBoardCell(qc, j.job.id, j.units[0].id, 11))!;
      expect(c.canRecord).toBe(false);
      expect(c.items.filter((i) => i.canInspect).map((i) => i.title)).toEqual(["step 3"]);
      expect(c.items.find((i) => i.title === "step 3")!.qc).toMatchObject({ state: "WAITING" });
    });

    it("shows an override against the item it started out of order", async () => {
      const j = await fixture();
      await owner.sequenceOverride.create({
        data: { jobId: j.job.id, targetKind: "ASSEMBLY_STEP", targetId: j.step(2, 0), unitId: j.units[0].id, category: "CREW_OR_MACHINE_FREE", note: "bay free", createdBy: sup.userId },
      });
      const c = (await loadBoardCell(sup, j.job.id, j.units[0].id, 11))!;
      expect(c.items.find((i) => i.title === "step 2")!.overrides).toMatchObject([{ category: "CREW_OR_MACHINE_FREE", note: "bay free", by: "sup" }]);
    });

    it("another tenant's cell is not found; a unit of another job is not found", async () => {
      const j = await fixture();
      const other = await fixture();
      expect(await loadBoardCell(bSup, j.job.id, j.units[0].id, 11)).toBeNull();
      expect(await loadBoardCell(sup, j.job.id, other.units[0].id, 11)).toBeNull();
    });
  });

  describe("loadTrackerSheet (the workbook's Units x Process Tracker)", () => {
    it("one row per process, one column per unit, the workbook's words", async () => {
      const j = await fixture();
      await owner.processPlan.update({ where: { id: j.plan("20", 1) }, data: { verifiedBy: qc.userId } });
      const t = (await loadTrackerSheet(sup, j.job.id))!;
      expect(t.serials).toHaveLength(2);
      expect(t.rows.map((r) => r.seq)).toEqual([20, 21, 22]);
      const byName = Object.fromEntries(t.rows.map((r) => [r.seq, r.cells]));
      expect(byName[20]).toEqual(["Complete", "Verified"]);
      expect(byName[21]).toEqual(["Started", "-"]);
      expect(byName[22]).toEqual(["-", "-"]);
      expect(t.rows[0].department).toBe("Fabrication");
    });

    it("another tenant's job is not found", async () => {
      const j = await fixture();
      expect(await loadTrackerSheet(bSup, j.job.id)).toBeNull();
    });
  });
});
