import { afterAll, describe, expect, it } from "vitest";

/**
 * Lean Core J3a — a route per equipment line.
 * Proves migration 20261021100000_j3a_line_routes (scope CHECK, the two partial
 * unique indexes, same-job trigger, equipment pins, tenant isolation) and the
 * behaviour of createJob / generateSchedule / loadFloorFacts around it: a line
 * on another published route gets its own UNIT-grain processes, a job whose
 * lines all run its own route is exactly as before.
 * Violation cases first, per CLAUDE.md. Gated behind RUN_DB_TESTS; every
 * fixture is its own disposable tenant (owner client bypasses RLS).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core J3a route per equipment line (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { ROLES } = await import("@/lib/authz");
  const { createJob } = await import("./job-intake.service");
  const { generateSchedule } = await import("./schedule.service");
  const { loadFloorFacts } = await import("./work.facts");
  const { addWorkingDays, DEFAULT_CALENDAR } = await import("@/lib/schedule");
  /** Planned date for `days` working days after the 2 Nov 2026 order date, by the engine's own calendar. */
  const due = (days: number) => addWorkingDays(new Date("2026-11-02"), days, DEFAULT_CALENDAR).toISOString().slice(0, 10);
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;

  /**
   * A disposable tenant with two families. Route A (the job's): 10 (JOB grain, office), 20, 30 — finish by day 5/15/25.
   * Route B (an exchanger-like family): X10 (JOB grain; the job's own wins), 20 (same code as A's), 25 — finish by 5/30/50.
   */
  async function world(label: string, opts: { bProvisionalTerminal?: boolean } = {}) {
    const org = await owner.organization.create({ data: { code: `TEST-J3A-${label}-${stamp}-${++n}`, name: `j3a ${label}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const user = await owner.user.create({
      data: { tenantId, email: `${uniq("u")}@test.local`, username: uniq("u"), passwordHash: "x", name: "Admin", mustChangePassword: false },
    });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const famA = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const famB = await owner.productFamily.create({ data: { tenantId, code: "HEAT_EXCHANGER", name: "HE" } });

    const route = async (familyId: number, name: string, procs: { seq: number; code: string; grain: "JOB" | "UNIT"; start: number; finish: number; prov?: boolean }[], edges: [string, string][]) => {
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
            provisional: p.prov ?? false,
            optional: p.code === "30",
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
        { seq: 3, code: "25", grain: "UNIT", start: 30, finish: 50, prov: opts.bProvisionalTerminal },
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
    type Line = { serials?: string[]; routeVersionId?: number | null; typeId?: number | null };
    const make = async (lines: Line[], extra: Record<string, unknown> = {}) =>
      createJob(actor, {
        clientId: client.id,
        familyId: famA.id,
        templateVersionId: tvA.id,
        calendarId: null,
        jobNumber: uniq("J3A"),
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
          equipmentTypeId: l.typeId ?? null,
          templateVersionId: l.routeVersionId ?? null,
          name: `Line ${i + 1}`,
          blockNo: i + 1,
          remarks: null,
          serials: l.serials ?? [`${label}-L${i + 1}-U1`],
        })),
        qcpTemplateSourceId: null,
        copyBomFromEquipmentId: null,
        ...extra,
      } as never);
    return { tenantId, org, dept, famA, famB, tvA, tvB, eqB, actor, make };
  }

  const procs = (jobId: number) =>
    owner.jobProcess.findMany({ where: { jobId }, orderBy: [{ seq: "asc" }, { id: "asc" }] });
  const sig = (rows: { code: string; equipmentId: number | null }[]) => rows.map((r) => `${r.code}@${r.equipmentId ?? "job"}`);

  afterAll(async () => {
    await owner.$disconnect();
  });

  // ── violation cases first ─────────────────────────────────────────────────
  describe("job_processes constraints", () => {
    it("refuses a line scope on a JOB-grain process (CHECK)", async () => {
      const w = await world("CHK");
      const j = await w.make([{}]);
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: j.jobId } });
      const jp = await owner.jobProcess.findFirstOrThrow({ where: { jobId: j.jobId, grain: "JOB" } });
      await expect(owner.jobProcess.update({ where: { id: jp.id }, data: { equipmentId: eq.id } })).rejects.toThrow(
        /job_processes_line_scope_chk|check constraint/i,
      );
    });

    it("refuses a line that belongs to another job (trigger)", async () => {
      const w = await world("SAMEJOB");
      const j1 = await w.make([{}]);
      const j2 = await w.make([{}]);
      const eqOfJ2 = await owner.equipment.findFirstOrThrow({ where: { jobId: j2.jobId } });
      const tp = await owner.jobProcess.findFirstOrThrow({ where: { jobId: j1.jobId, grain: "UNIT" } });
      await expect(
        owner.jobProcess.create({
          data: { jobId: j1.jobId, equipmentId: eqOfJ2.id, seq: 9, code: "99", name: "x", departmentId: tp.departmentId, grain: "UNIT" },
        }),
      ).rejects.toThrow(/does not belong to job/i);
    });

    it("refuses a duplicate code within one scope: job-level and per line", async () => {
      const w = await world("UNIQ");
      const j = await w.make([{}, { routeVersionId: w.tvB.id, typeId: w.eqB.id }]);
      const rows = await procs(j.jobId);
      const jobLevel = rows.find((r) => r.equipmentId == null && r.grain === "UNIT")!;
      const lineRow = rows.find((r) => r.equipmentId != null)!;
      const base = { jobId: j.jobId, seq: 50, name: "dup", departmentId: jobLevel.departmentId, grain: "UNIT" as const };
      await expect(owner.jobProcess.create({ data: { ...base, code: jobLevel.code } })).rejects.toThrow(/Unique constraint/i);
      await expect(owner.jobProcess.create({ data: { ...base, code: lineRow.code, equipmentId: lineRow.equipmentId } })).rejects.toThrow(
        /Unique constraint/i,
      );
    });
  });

  describe("createJob refusals", () => {
    it("refuses a line route that is not published", async () => {
      const w = await world("DRAFT");
      const draft = await owner.processTemplateVersion.create({
        data: { templateId: w.tvB.templateId, version: 2, status: "DRAFT" },
      });
      await expect(w.make([{}, { routeVersionId: draft.id }])).rejects.toMatchObject({ code: "TEMPLATE_VERSION_NOT_PUBLISHED" });
    });

    it("refuses a line route from another tenant", async () => {
      const w = await world("TENANT-A");
      const other = await world("TENANT-B");
      await expect(w.make([{}, { routeVersionId: other.tvB.id }])).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses an equipment type whose family is not its line's route family", async () => {
      const w = await world("FAMILY");
      // the exchanger type on a line that stays on the PV route
      await expect(w.make([{ typeId: w.eqB.id }])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("refuses an exclusion code no route in use has", async () => {
      const w = await world("EXCL");
      await expect(w.make([{}, { routeVersionId: w.tvB.id }], { excludedProcessCodes: ["77"], exclusionReason: "x" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });

  // ── a job on one route is exactly as before ───────────────────────────────
  describe("single-route job (every existing job)", () => {
    it("writes the job-level set only, pins the line to the job's version, and schedules one route", async () => {
      const w = await world("SINGLE");
      const j = await w.make([{ serials: ["S1", "S2"] }, { serials: ["S3"] }]);
      const rows = await procs(j.jobId);
      expect(sig(rows)).toEqual(["10@job", "20@job", "30@job"]);
      expect(j.processCount).toBe(3);
      expect(j.edgeCount).toBe(2);
      const lines = await owner.equipment.findMany({ where: { jobId: j.jobId } });
      expect(lines.map((e) => e.templateVersionId)).toEqual([w.tvA.id, w.tvA.id]);

      const run = await generateSchedule(w.actor, { jobId: j.jobId, mode: "FORWARD" });
      expect(run.processPlans).toHaveLength(1 + 2 * 3); // 10 is JOB grain (one plan); 20 and 30 x 3 units
      const terminalFinish = run.processPlans.filter((p) => rows.find((r) => r.id === p.jobProcessId)!.code === "30")[0].plannedFinish!;
      expect(terminalFinish.toISOString().slice(0, 10)).toBe(due(25)); // route A: terminal 30 finishes by day 25
    });
  });

  // ── a line on its own route ───────────────────────────────────────────────
  describe("two lines on two routes", () => {
    it("gives the line its own UNIT-grain rows, shares the job's JOB-grain rows, and wires its edges", async () => {
      const w = await world("TWO");
      const j = await w.make([{ serials: ["V1", "V2"] }, { routeVersionId: w.tvB.id, typeId: w.eqB.id, serials: ["E1"] }]);
      const eqs = await owner.equipment.findMany({ where: { jobId: j.jobId }, orderBy: { id: "asc" } });
      const he = eqs[1];
      const rows = await procs(j.jobId);
      // job route: 10 (JOB), 20, 30. line 2: its own 20 and 25. B's JOB-grain 10 is not duplicated.
      expect(sig(rows).sort()).toEqual(["10@job", "20@job", `20@${he.id}`, `25@${he.id}`, "30@job"].sort());
      expect(j.processCount).toBe(5);
      expect(eqs.map((e) => e.templateVersionId)).toEqual([w.tvA.id, w.tvB.id]);

      const id = (code: string, eq: number | null) => rows.find((r) => r.code === code && r.equipmentId === eq)!.id;
      const edges = await owner.jobProcessEdge.findMany({ where: { jobId: j.jobId } });
      const pairs = edges.map((e) => `${e.predecessorId}>${e.processId}`).sort();
      expect(pairs).toEqual(
        [
          `${id("10", null)}>${id("20", null)}`,
          `${id("20", null)}>${id("30", null)}`,
          `${id("10", null)}>${id("20", he.id)}`, // the line's 20 follows the job's office process 10
          `${id("20", he.id)}>${id("25", he.id)}`,
        ].sort(),
      );
      expect(j.droppedEdgeCount).toBe(0);
    });

    it("schedules both lines, each on its own envelope, in one current run", async () => {
      const w = await world("SCHED");
      const j = await w.make([{ serials: ["V1", "V2"] }, { routeVersionId: w.tvB.id, typeId: w.eqB.id, serials: ["E1"] }]);
      const eqs = await owner.equipment.findMany({ where: { jobId: j.jobId }, orderBy: { id: "asc" } });
      const units = await owner.unit.findMany({ where: { jobId: j.jobId } });
      const rows = await procs(j.jobId);
      const run = await generateSchedule(w.actor, { jobId: j.jobId, mode: "FORWARD" });
      expect(await owner.scheduleRun.count({ where: { jobId: j.jobId, isCurrent: true } })).toBe(1);
      const finishOf = (unitSerial: string, code: string) => {
        const unit = units.find((u) => u.serialNo === unitSerial)!;
        const plan = run.processPlans.find((p) => {
          const jp = rows.find((r) => r.id === p.jobProcessId)!;
          return p.unitId === unit.id && jp.code === code;
        })!;
        return plan.plannedFinish!.toISOString().slice(0, 10);
      };
      // L1.3: the JOB-grain 10 is ONE unit-less plan; vessel units: 2 own plans each (20, 30); exchanger unit: 2 (its 20, its 25)
      expect(run.processPlans.filter((p) => p.unitId == null)).toHaveLength(1);
      expect(run.processPlans.filter((p) => units.find((u) => u.id === p.unitId)?.serialNo === "V1")).toHaveLength(2);
      expect(run.processPlans.filter((p) => units.find((u) => u.id === p.unitId)?.serialNo === "E1")).toHaveLength(2);
      expect(finishOf("V1", "30")).toBe(due(25)); // route A: terminal 30, day 25
      expect(finishOf("E1", "25")).toBe(due(50)); // route B is longer: terminal 25 finishes by day 50
      expect(finishOf("E1", "20")).toBe(due(30)); // B's own 20 (finish by 30), not A's (finish by 15)
      // the exchanger's plans point at the exchanger's own process rows (the job's 10 is the unit-less plan)
      const hePlanProcs = run.processPlans.filter((p) => p.unitId === units.find((u) => u.serialNo === "E1")!.id).map((p) => p.jobProcessId);
      expect(rows.filter((r) => hePlanProcs.includes(r.id)).map((r) => `${r.code}@${r.equipmentId ?? "job"}`).sort()).toEqual(
        [`20@${eqs[1].id}`, `25@${eqs[1].id}`].sort(),
      );
    });

    it("L1.3: a JOB-grain process gets exactly one unit-less plan across two routes, and every unit's spine shows it", async () => {
      const w = await world("JOBGRAIN");
      const j = await w.make([{ serials: ["V1", "V2"] }, { routeVersionId: w.tvB.id, typeId: w.eqB.id, serials: ["E1"] }]);
      const rows = await procs(j.jobId);
      const office = rows.find((r) => r.code === "10" && r.equipmentId == null)!;
      expect(office.grain).toBe("JOB");
      await owner.jobProcess.update({ where: { id: office.id }, data: { workOrderStages: [1] } });

      const run = await generateSchedule(w.actor, { jobId: j.jobId, mode: "FORWARD" });
      const officePlans = run.processPlans.filter((p) => p.jobProcessId === office.id);
      expect(officePlans).toHaveLength(1);
      expect(officePlans[0].unitId).toBeNull();
      // a second reschedule keeps it at one (a new run version, not an accumulation)
      const again = await generateSchedule(w.actor, { jobId: j.jobId, mode: "FORWARD" });
      expect(again.processPlans.filter((p) => p.jobProcessId === office.id)).toHaveLength(1);
      expect(again.processPlans.filter((p) => p.unitId == null)).toHaveLength(1);

      // both routes' units (vessels and the exchanger) show stage 1 through the one plan
      const spine = await withTenant(w.tenantId, (tx) =>
        tx.$queryRaw<{ unit_id: number; governing_plan_id: number }[]>`
          select unit_id, governing_plan_id from v_unit_stage_status where job_id = ${j.jobId} and stage_no = 1`,
      );
      expect(spine).toHaveLength(3);
      const currentOfficePlan = again.processPlans.find((p) => p.jobProcessId === office.id)!;
      expect(spine.map((r) => r.governing_plan_id)).toEqual([currentOfficePlan.id, currentOfficePlan.id, currentOfficePlan.id]);
    });

    it("an infeasible line makes the whole job infeasible; BACKWARD starts early enough for the longest line", async () => {
      const w = await world("FEAS");
      const j = await w.make([{}, { routeVersionId: w.tvB.id, typeId: w.eqB.id }]);
      // 30 working days is enough for A (25) but not for B (50)
      const tight = await generateSchedule(w.actor, {
        jobId: j.jobId,
        mode: "FORWARD",
        projectStartDate: new Date("2026-11-02"),
        requiredDeliveryDate: new Date("2026-12-14"),
      });
      expect(tight.feasibility).toBe("INFEASIBLE");
      expect(tight.shortfallDays).toBeGreaterThan(0);

      const back = await generateSchedule(w.actor, { jobId: j.jobId, mode: "BACKWARD", requiredDeliveryDate: new Date("2027-03-01") });
      const rows = await procs(j.jobId);
      const terminalB = rows.find((r) => r.code === "25")!;
      const planB = back.processPlans.find((p) => p.jobProcessId === terminalB.id)!;
      expect(planB.plannedFinish!.toISOString().slice(0, 10)).toBe("2027-03-01"); // the longest route lands on the delivery date
    });

    it("refuses to schedule when the line's own terminal has no duration (not guessed)", async () => {
      const w = await world("PROV", { bProvisionalTerminal: true });
      const j = await w.make([{}, { routeVersionId: w.tvB.id, typeId: w.eqB.id }]);
      await expect(generateSchedule(w.actor, { jobId: j.jobId, mode: "FORWARD" })).rejects.toMatchObject({ code: "SCHEDULE_DATA_MISSING" });
    });

    it("BACKWARD with no delivery date refuses, naming the missing date (not durations)", async () => {
      const w = await world("NODATE");
      const j = await w.make([{}]);
      await owner.job.update({ where: { id: j.jobId }, data: { committedDeliveryDate: null } });
      await expect(generateSchedule(w.actor, { jobId: j.jobId, mode: "BACKWARD" })).rejects.toMatchObject({
        code: "SCHEDULE_DATA_MISSING",
        detail: { missing: "committedDeliveryDate" },
      });
    });
  });

  describe("floor: exclusions stay on their own route", () => {
    it("excluding code 20 on the exchanger line does not exclude the vessel line's 20, and vice versa", async () => {
      const w = await world("FLOOR");
      const j = await w.make([{ serials: ["V1"] }, { routeVersionId: w.tvB.id, typeId: w.eqB.id, serials: ["E1"] }]);
      const eqs = await owner.equipment.findMany({ where: { jobId: j.jobId }, orderBy: { id: "asc" } });
      const units = await owner.unit.findMany({ where: { jobId: j.jobId } });
      const vUnit = units.find((u) => u.serialNo === "V1")!;
      const eUnit = units.find((u) => u.serialNo === "E1")!;
      await owner.jobProcess.updateMany({ where: { jobId: j.jobId, code: "20", equipmentId: eqs[1].id }, data: { included: false } });

      const job = { id: j.jobId, familyId: w.famA.id };
      const seqs = async (unitId: number) =>
        withTenant(w.tenantId, async (tx) => (await loadFloorFacts(tx, job, unitId)).facts.excludedProcessSeqs.sort());
      expect(await seqs(eUnit.id)).toEqual([20]);
      expect(await seqs(vUnit.id)).toEqual([]);

      await owner.jobProcess.updateMany({ where: { jobId: j.jobId, code: "30", equipmentId: null }, data: { included: false } });
      expect(await seqs(vUnit.id)).toEqual([30]); // job-route exclusion: the vessel only
      expect(await seqs(eUnit.id)).toEqual([20]); // the exchanger never had a "30"
    });
  });

  describe("tenant isolation", () => {
    it("a tenant cannot read another tenant's line-scoped processes", async () => {
      const a = await world("ISO-A");
      const b = await world("ISO-B");
      const j = await a.make([{}, { routeVersionId: a.tvB.id, typeId: a.eqB.id }]);
      const seen = await withTenant(b.tenantId, (tx) => tx.jobProcess.count({ where: { jobId: j.jobId } }));
      expect(seen).toBe(0);
      const own = await withTenant(a.tenantId, (tx) => tx.jobProcess.count({ where: { jobId: j.jobId, equipmentId: { not: null } } }));
      expect(own).toBe(2);
    });
  });
});
