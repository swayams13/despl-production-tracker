import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Lean Core J3b: line-aware reads. Proves migration 20261024100000_j3b_line_stage_view and
 * the readers that now scope to a unit's route (rollupForSeq, board, board cell, tracker
 * export, stage detail, Gantt, workspace, materials). Fixture modelled on j3a-line-routes:
 * route A (the job's) = 10 JOB, 20, 30; route B (a line) = 10 JOB, 20, 25. A single-route job
 * must read as before. Gated behind RUN_DB_TESTS; every fixture is its own disposable tenant.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core J3b line-aware reads (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { ROLES } = await import("@/lib/authz");
  const { createJob } = await import("./job-intake.service");
  const { generateSchedule } = await import("./schedule.service");
  const { rollupForAssemblyStep } = await import("./_shared");
  const { loadJobBoard } = await import("./board.read");
  const { loadBoardCell } = await import("./board.cell.read");
  const { loadTrackerSheet } = await import("./board.export.read");
  const { loadStageDetail } = await import("./stage-detail.read");
  const { loadJobGantt } = await import("./gantt.read");
  const { loadPrioritizedJob } = await import("./workspace.read");
  const { loadJobMaterials } = await import("./job-materials.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;

  async function world(label: string) {
    const org = await owner.organization.create({ data: { code: `TEST-J3B-${label}-${stamp}-${++n}`, name: `j3b ${label}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const user = await owner.user.create({
      data: { tenantId, email: `${uniq("u")}@test.local`, username: uniq("u"), passwordHash: "x", name: "Admin", mustChangePassword: false },
    });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const famA = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const famB = await owner.productFamily.create({ data: { tenantId, code: "HEAT_EXCHANGER", name: "HE" } });
    // each family names its own stages: the same number means different work on the two lines
    for (const [familyId, names] of [
      [famA.id, ["Office A", "Fabricate A", "Test A"]],
      [famB.id, ["Office B", "Tube fit B", "Hydro B", "Dispatch B"]],
    ] as const) {
      for (const [i, name] of names.entries()) await owner.workOrderStage.create({ data: { tenantId, familyId, stageNo: i + 1, name } });
    }

    const route = async (familyId: number, name: string, procs: { seq: number; code: string; grain: "JOB" | "UNIT"; start: number; finish: number }[], edges: [string, string][]) => {
      const tpl = await owner.processTemplate.create({ data: { tenantId, familyId, name } });
      const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
      const rows = new Map<string, number>();
      for (const p of procs) {
        const r = await owner.templateProcess.create({
          data: {
            versionId: tv.id,
            seq: p.seq,
            code: p.code,
            name: `${name} ${p.code}`,
            defaultDepartmentId: dept.id,
            grain: p.grain,
            durationMinDays: p.finish - p.start,
            durationMaxDays: p.finish - p.start,
            envelopeStartByMinDays: p.start,
            envelopeStartByMaxDays: p.start,
            envelopeFinishByMinDays: p.finish,
            envelopeFinishByMaxDays: p.finish,
          },
        });
        rows.set(p.code, r.id);
      }
      for (const [pred, proc] of edges) {
        await owner.templateEdge.create({
          data: { versionId: tv.id, processId: rows.get(proc)!, predecessorId: rows.get(pred)!, type: "FINISH_TO_START", lagDays: 0 },
        });
      }
      return tv;
    };
    const tvA = await route(
      famA.id,
      "A",
      [
        { seq: 1, code: "10", grain: "JOB", start: 0, finish: 5 },
        { seq: 2, code: "20", grain: "UNIT", start: 5, finish: 15 },
        { seq: 3, code: "30", grain: "UNIT", start: 15, finish: 25 },
      ],
      [["10", "20"], ["20", "30"]],
    );
    const tvB = await route(
      famB.id,
      "B",
      [
        { seq: 1, code: "10", grain: "JOB", start: 0, finish: 5 },
        { seq: 2, code: "20", grain: "UNIT", start: 5, finish: 30 },
        { seq: 3, code: "25", grain: "UNIT", start: 30, finish: 50 },
      ],
      [["10", "20"], ["20", "25"]],
    );
    const eqB = await owner.equipmentTypeRef.create({ data: { tenantId, familyId: famB.id, code: "HE-FIXED", name: "Fixed tubesheet" } });
    const actor = {
      userId: user.id,
      tenantId,
      clientId: null,
      name: "Admin",
      email: user.email,
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM" as const,
      outdoorMode: false,
    };
    const make = async (lines: { serials: string[]; route?: boolean }[]) =>
      createJob(actor, {
        clientId: client.id,
        familyId: famA.id,
        templateVersionId: tvA.id,
        calendarId: null,
        jobNumber: uniq("J3B"),
        clientOrderNo: null,
        projectName: null,
        poRef: null,
        designCode: null,
        orderDate: new Date("2026-11-02"),
        committedDeliveryDate: null,
        targetDispatchDate: null,
        priority: "NORMAL",
        remarks: null,
        excludedProcessCodes: [],
        exclusionReason: null,
        equipments: lines.map((l, i) => ({
          equipmentTypeId: l.route ? eqB.id : null,
          templateVersionId: l.route ? tvB.id : null,
          name: l.route ? "Exchanger line" : `Vessel line ${i + 1}`,
          blockNo: i + 1,
          remarks: null,
          serials: l.serials,
        })),
        qcpTemplateSourceId: null,
        copyBomFromEquipmentId: null,
      } as never);
    return { tenantId, dept, actor, make };
  }

  type World = Awaited<ReturnType<typeof world>>;
  /** Stage numbers per process for the fixture: job route 10/20/30 -> 1/2/3; line route 20/25 -> 2/4. */
  async function twoRoutes(label: string, w?: World) {
    const world_ = w ?? (await world(label));
    const j = await world_.make([{ serials: ["V1", "V2"] }, { serials: ["E1"], route: true }]);
    const rows = await owner.jobProcess.findMany({ where: { jobId: j.jobId }, orderBy: [{ seq: "asc" }, { id: "asc" }] });
    const stageOf: Record<string, number> = { "10": 1, "20": 2, "30": 3, "25": 4 };
    for (const r of rows) await owner.jobProcess.update({ where: { id: r.id }, data: { workOrderStages: [stageOf[r.code]] } });
    await generateSchedule(world_.actor, { jobId: j.jobId, mode: "FORWARD" });
    const units = await owner.unit.findMany({ where: { jobId: j.jobId } });
    const unit = (s: string) => units.find((u) => u.serialNo === s)!;
    const lineRow = (code: string) => rows.find((r) => r.code === code && r.equipmentId != null)!;
    const jobRow = (code: string) => rows.find((r) => r.code === code && r.equipmentId == null)!;
    return { w: world_, jobId: j.jobId, rows, unit, lineRow, jobRow };
  }

  const view = (tenantId: number, jobId: number) =>
    withTenant(tenantId, (tx) =>
      tx.$queryRaw<{ unit_id: number; stage_no: number; fill_status: string }[]>`
        select unit_id, stage_no, fill_status from v_unit_stage_status where job_id = ${jobId} order by unit_id, stage_no`,
    );

  afterAll(async () => {
    await owner.$disconnect();
  });

  // ── the view ──────────────────────────────────────────────────────────────
  describe("v_unit_stage_status", () => {
    it("gives each unit only its own route's stages", async () => {
      const t = await twoRoutes("VIEW");
      const rows = await view(t.w.tenantId, t.jobId);
      const stagesOf = (s: string) => rows.filter((r) => r.unit_id === t.unit(s).id).map((r) => r.stage_no);
      expect(stagesOf("V1")).toEqual([1, 2, 3]);
      expect(stagesOf("V2")).toEqual([1, 2, 3]);
      expect(stagesOf("E1")).toEqual([1, 2, 4]); // not the job's 30 (stage 3)
    });

    it("a line unit's stage reads complete when its own plan completes (it never could against the job-level row)", async () => {
      const t = await twoRoutes("COMPLETE");
      const e1 = t.unit("E1");
      await owner.processPlan.updateMany({
        where: { unitId: e1.id, jobProcessId: t.lineRow("20").id, scheduleRun: { isCurrent: true } },
        data: { status: "COMPLETE", actualStart: new Date(), actualFinish: new Date() },
      });
      const rows = await view(t.w.tenantId, t.jobId);
      const at = (s: string, stage: number) => rows.find((r) => r.unit_id === t.unit(s).id && r.stage_no === stage)!.fill_status;
      expect(at("E1", 2)).toBe("complete");
      expect(at("V1", 2)).not.toBe("complete"); // the vessels' own plan is untouched
    });

    it("a single-route job reads exactly as the L1.3 view did", async () => {
      const w = await world("SINGLE");
      const j = await w.make([{ serials: ["S1", "S2"] }]);
      const rows = await owner.jobProcess.findMany({ where: { jobId: j.jobId } });
      for (const r of rows) await owner.jobProcess.update({ where: { id: r.id }, data: { workOrderStages: [({ "10": 1, "20": 2, "30": 3 } as Record<string, number>)[r.code]] } });
      await generateSchedule(w.actor, { jobId: j.jobId, mode: "FORWARD" });
      expect(await view(w.tenantId, j.jobId)).toEqual(await oldView(w.tenantId, j.jobId));
    });

    // The L1.3 view body, run as a query: the J3b view must return the same rows wherever no line has its own route.
    const oldBody = (() => {
      const sql = readFileSync("prisma/migrations/20261023100000_l13_job_grain_stage_view/migration.sql", "utf8");
      return sql.slice(sql.indexOf("WITH exploded")).replace(/;\s*$/, "");
    })();
    const oldView = (tenantId: number, jobId: number) =>
      withTenant(tenantId, (tx) =>
        tx.$queryRawUnsafe<{ unit_id: number; stage_no: number; fill_status: string }[]>(
          `select unit_id, stage_no, fill_status from (${oldBody}) v where job_id = ${jobId} order by unit_id, stage_no`,
        ),
      );

    it("DESPL-320's rows are identical before and after (full column snapshot)", async () => {
      const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" }, select: { id: true, tenantId: true } });
      if (!job) return; // seed not loaded in this database
      const cols = "job_id, unit_id, stage_no, fill_status, is_overdue, is_rejected, governing_plan_id";
      const now = await withTenant(job.tenantId, (tx) =>
        tx.$queryRawUnsafe(`select ${cols} from v_unit_stage_status where job_id = ${job.id} order by unit_id, stage_no`),
      );
      const before = await withTenant(job.tenantId, (tx) =>
        tx.$queryRawUnsafe(`select ${cols} from (${oldBody}) v where job_id = ${job.id} order by unit_id, stage_no`),
      );
      expect((now as unknown[]).length).toBeGreaterThan(0);
      expect(now).toEqual(before);
    });
  });

  // ── rollupForSeq ──────────────────────────────────────────────────────────
  describe("rollupForSeq (through rollupForAssemblyStep)", () => {
    async function mappedStep(t: Awaited<ReturnType<typeof twoRoutes>>, serial: string, seq: number) {
      const tenantId = t.w.tenantId;
      const fam = await owner.productFamily.findFirstOrThrow({ where: { tenantId, code: "PRESSURE_VESSEL" } });
      const at = await owner.assemblyTemplate.create({ data: { tenantId, familyId: fam.id, name: uniq("asm") } });
      const av = await owner.assemblyTemplateVersion.create({ data: { templateId: at.id, version: 1, status: "PUBLISHED" } });
      const ts = await owner.assemblyTemplateStep.create({
        data: { versionId: av.id, seq: 1, groupCode: "G", groupName: "G", srNo: "1", activity: "Do it", kind: "WORK", defaultDepartmentId: t.w.dept.id, leadTimeProcessSeq: seq, requiresQc: false },
      });
      const unit = t.unit(serial);
      return owner.assemblyStep.create({
        data: { jobId: t.jobId, unitId: unit.id, templateStepId: ts.id, seq: 1, status: "COMPLETE", finishedAt: new Date(), requiresQc: false },
      });
    }
    const roll = (t: Awaited<ReturnType<typeof twoRoutes>>, stepId: number) =>
      withTenant(t.w.tenantId, (tx) => rollupForAssemblyStep(tx, t.w.actor, stepId));

    it("a line unit's step rolls up the LINE's process, not the job-level row with the same code", async () => {
      const t = await twoRoutes("ROLL-LINE");
      const step = await mappedStep(t, "E1", 20);
      const change = await roll(t, step.id);
      const plan = await owner.processPlan.findFirstOrThrow({ where: { unitId: t.unit("E1").id, jobProcessId: t.lineRow("20").id, scheduleRun: { isCurrent: true } } });
      expect(change).toMatchObject({ processPlanId: plan.id, to: "COMPLETE" });
    });

    it("a unit on the job's own route still rolls up the job-level row", async () => {
      const t = await twoRoutes("ROLL-JOB");
      const step = await mappedStep(t, "V1", 20);
      const change = await roll(t, step.id);
      const plan = await owner.processPlan.findFirstOrThrow({ where: { unitId: t.unit("V1").id, jobProcessId: t.jobRow("20").id, scheduleRun: { isCurrent: true } } });
      expect(change).toMatchObject({ processPlanId: plan.id, to: "COMPLETE" });
    });
  });

  // ── the readers ───────────────────────────────────────────────────────────
  describe("two-route job", () => {
    it("board: one group per line, each with its own stage names and only its own cells", async () => {
      const t = await twoRoutes("BOARD");
      const b = (await loadJobBoard(t.w.actor, t.jobId))!;
      expect(b.lines!.map((l) => l.name)).toEqual(["Vessel line 1", "Exchanger line"]);
      const [vessels, exch] = b.lines!;
      expect(vessels.unitIds).toHaveLength(2);
      expect(vessels.stages.map((s) => [s.stageNo, s.name])).toEqual([[1, "Office A"], [2, "Fabricate A"], [3, "Test A"]]);
      expect(exch.stages.map((s) => [s.stageNo, s.name])).toEqual([[1, "Office B"], [2, "Tube fit B"], [4, "Dispatch B"]]);
      const e1 = b.units.find((u) => u.serialNo === "E1")!;
      expect(Object.keys(e1.cells).map(Number)).toEqual([1, 2, 4]);
      expect(e1.currentStage).toMatchObject({ stageNo: 1, name: "Office B" });
    });

    it("board cell and stage detail read the unit's own route", async () => {
      const t = await twoRoutes("CELL");
      const e1 = t.unit("E1");
      const v1 = t.unit("V1");
      const dE = (await loadStageDetail(t.w.actor, t.jobId, e1.id, 2))!;
      const dV = (await loadStageDetail(t.w.actor, t.jobId, v1.id, 2))!;
      expect(dE.stageName).toBe("Tube fit B");
      expect(dV.stageName).toBe("Fabricate A");
      expect(dE.backingPlans.map((p) => p.jobProcessId)).toEqual([t.lineRow("20").id]);
      expect(dV.backingPlans.map((p) => p.jobProcessId)).toEqual([t.jobRow("20").id]);
      const cell = (await loadBoardCell(t.w.actor, t.jobId, e1.id, 2))!;
      expect(cell.detail.stageName).toBe("Tube fit B");
    });

    it("tracker sheet: a unit has a cell only for processes of its route", async () => {
      const t = await twoRoutes("SHEET");
      await owner.processPlan.updateMany({
        where: { jobProcessId: { in: [t.lineRow("25").id, t.jobRow("30").id] }, scheduleRun: { isCurrent: true } },
        data: { status: "IN_PROGRESS", actualStart: new Date() },
      });
      const sheet = (await loadTrackerSheet(t.w.actor, t.jobId))!;
      const col = (s: string) => sheet.serials.indexOf(s);
      const cell = (name: RegExp, s: string) => sheet.rows.find((r) => name.test(r.name))!.cells[col(s)];
      expect(cell(/^A 30$/, "E1")).toBe("-");
      expect(cell(/^B 25 \(Exchanger line\)$/, "V1")).toBe("-");
      expect(cell(/^B 25 \(Exchanger line\)$/, "E1")).toBe("Started");
      expect(cell(/^A 30$/, "V1")).toBe("Started");
    });

    it("Gantt: each unit's bars are its route's, grouped by line and 'Whole order'", async () => {
      const t = await twoRoutes("GANTT");
      const g = (await loadJobGantt(t.w.actor, t.jobId))!;
      const e1 = g.units.find((u) => u.serialNo === "E1")!;
      const v1 = g.units.find((u) => u.serialNo === "V1")!;
      expect(e1.bars.map((b) => b.code)).toEqual(["10", "20", "25"]);
      expect(v1.bars.map((b) => b.code)).toEqual(["10", "20", "30"]);
      expect(e1.line).toBe("Exchanger line");
      expect(e1.bars.map((b) => b.group)).toEqual(["Whole order", "Exchanger line", "Exchanger line"]);
      expect(v1.bars[0].group).toBe("Whole order");
    });

    it("workspace: float is computed per route (the shorter line's terminal is critical on its own route)", async () => {
      const t = await twoRoutes("FLOAT");
      const p = (await loadPrioritizedJob(t.w.actor, t.jobId))!;
      const ranked = [...p.rankedByDept.values()].flat();
      const terminalA = ranked.find((r) => r.plan.jobProcessId === t.jobRow("30").id)!;
      const terminalB = ranked.find((r) => r.plan.jobProcessId === t.lineRow("25").id)!;
      expect(terminalA.criticalPath).toBe(true); // against the whole spine it would carry 25 days of float
      expect(terminalB.criticalPath).toBe(true);
    });

    it("materials loads for a two-route job", async () => {
      const t = await twoRoutes("MATS");
      expect(await loadJobMaterials(t.w.actor, t.jobId)).not.toBeNull();
    });
  });

  describe("single-route job", () => {
    it("renders without line groups", async () => {
      const w = await world("NOLINES");
      const j = await w.make([{ serials: ["S1"] }]);
      const rows = await owner.jobProcess.findMany({ where: { jobId: j.jobId } });
      for (const r of rows) await owner.jobProcess.update({ where: { id: r.id }, data: { workOrderStages: [({ "10": 1, "20": 2, "30": 3 } as Record<string, number>)[r.code]] } });
      await generateSchedule(w.actor, { jobId: j.jobId, mode: "FORWARD" });
      const b = (await loadJobBoard(w.actor, j.jobId))!;
      expect("lines" in b).toBe(false);
      expect(b.stages.map((s) => s.name)).toEqual(["Office A", "Fabricate A", "Test A"]);
      const g = (await loadJobGantt(w.actor, j.jobId))!;
      expect(g.units[0].bars.every((x) => !("group" in x))).toBe(true);
      expect("line" in g.units[0]).toBe(false);
    });
  });
});
