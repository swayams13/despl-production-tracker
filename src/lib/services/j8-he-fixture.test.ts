import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lean Core J8-code: the milestone wiring, and the heat-exchanger wiring proved on
 * a SYNTHETIC family. Nothing here is real exchanger data (that waits for I10, I11
 * and decision D19): the processes, hydro steps, equipment types and tube routes
 * are invented test fixtures in a disposable tenant.
 *
 * The fixture family has shell-side and tube-side hydro, two equipment types, a tube
 * route with variant A "expansion" and variant B "grommet", and a milestone map.
 * Violation cases first, per CLAUDE.md. Gated behind RUN_DB_TESTS; the owner client
 * bypasses RLS to build the fixture, reads go through the service layer.
 */
const h = vi.hoisted(() => ({ actor: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/session", () => ({ readSession: async () => null }));
vi.mock("@/lib/authz", async (orig) => ({ ...(await orig<typeof import("@/lib/authz")>()), requireActor: async () => h.actor }));

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core J8 milestones and a synthetic heat-exchanger family (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { ROLES } = await import("@/lib/authz");
  const { FEATURES } = await import("@/lib/shared/flags");
  const { createJob } = await import("./job-intake.service");
  const { createJobAction } = await import("@/app/actions/job-intake");
  const { generateSchedule } = await import("./schedule.service");
  const { loadJobMilestones, loadMilestonesBatch } = await import("./milestone.read");
  const { loadPortfolio } = await import("./portfolio.read");
  const { ensureMilestones } = await import("./milestones.setup");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const flags = FEATURES as unknown as { multiFamilyIntake: boolean };
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;

  // Synthetic fixture only. Durations (max days) are finish minus start: 5, 10, 20, 15, 5, 5, 3.
  const PROCS = [
    { code: "H1", grain: "JOB", start: 0, finish: 5, ms: "ENG" },
    { code: "H2", grain: "JOB", start: 5, finish: 15, ms: "MAT" },
    { code: "H3", grain: "UNIT", start: 15, finish: 35, ms: "FAB" }, // shell
    { code: "H4", grain: "UNIT", start: 35, finish: 50, ms: "FAB" }, // tube bundle, expansion or grommet
    { code: "H5", grain: "UNIT", start: 50, finish: 55, ms: "TEST" }, // shell-side hydro
    { code: "H6", grain: "UNIT", start: 55, finish: 60, ms: "TEST" }, // tube-side hydro
    { code: "H7", grain: "UNIT", start: 60, finish: 63, ms: "DISP" },
  ] as const;
  const MILESTONES = [
    { code: "ENG", name: "Engineering approved" },
    { code: "MAT", name: "Material ready" },
    { code: "FAB", name: "Fabrication" },
    { code: "TEST", name: "Pressure test" },
    { code: "DISP", name: "Dispatched" },
  ];

  async function world(label: string, opts: { milestones?: boolean; stageList?: boolean } = {}) {
    const org = await owner.organization.create({ data: { code: `TEST-J8-${label}-${stamp}-${++n}`, name: `j8 ${label}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const user = await owner.user.create({
      data: { tenantId, email: `${uniq("u")}@test.local`, username: uniq("u"), passwordHash: "x", name: "Admin", mustChangePassword: false },
    });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const fam = await owner.productFamily.create({ data: { tenantId, code: "HEAT_EXCHANGER", name: "Synthetic HE" } });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: fam.id, name: "Synthetic HE route" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    const rows: number[] = [];
    for (const [i, p] of PROCS.entries()) {
      const r = await owner.templateProcess.create({
        data: {
          versionId: tv.id,
          seq: i + 1,
          code: p.code,
          name: `Synthetic ${p.code}`,
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
      if (i > 0) await owner.templateEdge.create({ data: { versionId: tv.id, processId: r.id, predecessorId: rows[i - 1], type: "FINISH_TO_START", lagDays: 0 } });
      rows.push(r.id);
    }
    const typeFixed = await owner.equipmentTypeRef.create({ data: { tenantId, familyId: fam.id, code: "SYN-FIXED", name: "Synthetic fixed tubesheet" } });
    const typeMed = await owner.equipmentTypeRef.create({ data: { tenantId, familyId: fam.id, code: "SYN-MED", name: "Synthetic MED evaporator" } });
    if (opts.stageList) await owner.workOrderStage.create({ data: { tenantId, familyId: fam.id, stageNo: 1, name: "Synthetic stage 1" } });
    if (opts.milestones !== false) {
      await owner.$transaction((tx) =>
        ensureMilestones(tx, tenantId, {
          apply: true,
          auditSource: "j8-he-fixture.test",
          milestones: MILESTONES,
          maps: { HEAT_EXCHANGER: Object.fromEntries(PROCS.map((p) => [p.code, p.ms])) },
        }),
      );
    }
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
    const input = (serials: string[][]) =>
      ({
        clientId: client.id,
        familyId: fam.id,
        templateVersionId: tv.id,
        calendarId: null,
        jobNumber: uniq("HE"),
        clientOrderNo: null,
        projectName: null,
        poRef: null,
        designCode: null,
        orderDate: new Date("2026-11-02"),
        committedDeliveryDate: new Date("2027-03-31"),
        targetDispatchDate: null,
        priority: "NORMAL",
        remarks: null,
        excludedProcessCodes: [],
        exclusionReason: null,
        equipments: serials.map((s, i) => ({
          equipmentTypeId: i === 0 ? typeFixed.id : typeMed.id,
          templateVersionId: null,
          name: `Exchanger ${i + 1}`,
          blockNo: i + 1,
          remarks: null,
          serials: s,
        })),
        qcpTemplateSourceId: null,
        copyBomFromEquipmentId: null,
      }) as never;
    const makeJob = async (serials = [["HE-1", "HE-2"]]) => {
      const job = await createJob(actor, input(serials));
      await generateSchedule(actor, { jobId: job.jobId, mode: "FORWARD" });
      return job.jobId;
    };
    return { tenantId, fam, tv, actor, input, makeJob, typeFixed, typeMed };
  }

  /** Mark every plan of one process code on a job COMPLETE (optionally only some units). */
  const complete = (jobId: number, code: string, unitIds?: number[]) =>
    owner.processPlan.updateMany({
      where: { jobId, jobProcess: { code }, scheduleRun: { isCurrent: true }, ...(unitIds ? { unitId: { in: unitIds } } : {}) },
      data: { status: "COMPLETE", actualStart: new Date("2026-11-03"), actualFinish: new Date("2026-11-04") },
    });

  beforeEach(() => {
    flags.multiFamilyIntake = false;
  });
  afterAll(async () => {
    flags.multiFamilyIntake = false;
    await owner.$disconnect();
  });

  // ── violation cases first ─────────────────────────────────────────────────
  describe("multi-family intake stays frozen unless the flag is on", () => {
    it("createJobAction refuses a heat-exchanger job with FEATURE_FROZEN while the flag is off, accepts it when on", async () => {
      const w = await world("FLAG");
      h.actor = w.actor;
      const refused = await createJobAction(w.input([["F-1"]]));
      expect(refused).toMatchObject({ ok: false, code: "FEATURE_FROZEN" });
      expect(await owner.job.count({ where: { tenantId: w.tenantId } })).toBe(0);

      flags.multiFamilyIntake = true;
      const ok = await createJobAction(w.input([["F-1"]]));
      expect(ok).toMatchObject({ ok: true });
      expect(await owner.job.count({ where: { tenantId: w.tenantId } })).toBe(1);
    });
  });

  describe("tables", () => {
    it("refuse a duplicate milestone code and a second milestone for the same process code (unique)", async () => {
      const w = await world("UNIQ");
      const first = await owner.milestone.findFirstOrThrow({ where: { tenantId: w.tenantId } });
      await expect(owner.milestone.create({ data: { tenantId: w.tenantId, code: first.code, name: "dup", sortOrder: 999 } })).rejects.toThrow(/Unique constraint/i);
      await expect(
        owner.milestoneProcessMap.create({ data: { tenantId: w.tenantId, familyId: w.fam.id, processCode: "H1", milestoneId: first.id } }),
      ).rejects.toThrow(/Unique constraint/i);
    });

    it("refuses a zero or negative weight (CHECK)", async () => {
      const w = await world("WEIGHT");
      const m = await owner.milestone.findFirstOrThrow({ where: { tenantId: w.tenantId } });
      await expect(
        owner.milestoneProcessMap.create({ data: { tenantId: w.tenantId, familyId: w.fam.id, processCode: "H9", milestoneId: m.id, weight: 0 } }),
      ).rejects.toThrow(/milestone_process_maps_weight_chk|check constraint/i);
    });

    it("a tenant cannot read another tenant's milestones or map rows (RLS)", async () => {
      const a = await world("ISO-A");
      const b = await world("ISO-B");
      const aIds = (await owner.milestone.findMany({ where: { tenantId: a.tenantId } })).map((m) => m.id);
      expect(aIds).toHaveLength(MILESTONES.length);
      expect(await withTenant(b.tenantId, (tx) => tx.milestone.count({ where: { id: { in: aIds } } }))).toBe(0);
      expect(await withTenant(b.tenantId, (tx) => tx.milestoneProcessMap.count({ where: { familyId: a.fam.id } }))).toBe(0);
      expect(await withTenant(a.tenantId, (tx) => tx.milestoneProcessMap.count({ where: { familyId: a.fam.id } }))).toBe(PROCS.length);
    });
  });

  describe("scripts/lean-seed-milestones (ensureMilestones)", () => {
    it("dry run writes nothing; apply creates D9's ten names and the provisional PV map once; a re-run leaves an edited row alone", async () => {
      const org = await owner.organization.create({ data: { code: `TEST-J8-SEED-${stamp}-${++n}`, name: "j8 seed" } });
      const pv = await owner.productFamily.create({ data: { tenantId: org.id, code: "PRESSURE_VESSEL", name: "PV" } });
      const run = (apply: boolean) => owner.$transaction((tx) => ensureMilestones(tx, org.id, { apply, auditSource: "test" }));

      const dry = await run(false);
      expect(dry.milestonesCreated).toHaveLength(10);
      expect(dry.mapsCreated).toEqual([{ family: "PRESSURE_VESSEL", count: 36 }]);
      expect(await owner.milestone.count({ where: { tenantId: org.id } })).toBe(0);
      expect(await owner.auditLog.count({ where: { tenantId: org.id } })).toBe(0);

      await run(true);
      expect(await owner.milestone.count({ where: { tenantId: org.id } })).toBe(10);
      expect(await owner.milestoneProcessMap.count({ where: { familyId: pv.id } })).toBe(36);
      const audit = await owner.auditLog.findMany({ where: { tenantId: org.id, action: "milestone.map.seed" }, take: 1 });
      expect(audit[0].after).toMatchObject({ provisional: true });

      // SJ edits process 21 to another milestone; a re-run must not put it back.
      const doc = await owner.milestone.findFirstOrThrow({ where: { tenantId: org.id, code: "DOC" } });
      await owner.milestoneProcessMap.update({ where: { familyId_processCode: { familyId: pv.id, processCode: "21" } }, data: { milestoneId: doc.id, weight: 7 } });
      const again = await run(true);
      expect(again.milestonesCreated).toEqual([]);
      expect(again.mapsCreated).toEqual([{ family: "PRESSURE_VESSEL", count: 0 }]);
      expect(await owner.milestoneProcessMap.findUniqueOrThrow({ where: { familyId_processCode: { familyId: pv.id, processCode: "21" } } })).toMatchObject({ milestoneId: doc.id });
    });
  });

  describe("reads", () => {
    it("another tenant's actor gets nothing for the job, and never its numbers in a batch", async () => {
      const a = await world("READ-A");
      const b = await world("READ-B");
      const jobId = await a.makeJob();
      expect(await loadJobMilestones(b.actor, jobId)).toBeNull();
      expect((await loadMilestonesBatch(b.actor, [jobId])).size).toBe(0);
    });

    it("process_plans are filtered by job: finishing every plan of job B moves nothing on job A", async () => {
      const w = await world("JOBFILTER");
      const a = await w.makeJob([["A-1"]]);
      const b = await w.makeJob([["B-1"]]);
      for (const p of PROCS) await complete(b, p.code);
      const both = await loadMilestonesBatch(w.actor, [a, b]);
      expect(both.get(b)!.current).toBeNull();
      expect(both.get(b)!.milestones.every((m) => m.percent === 100 && m.state === "COMPLETE")).toBe(true);
      expect(both.get(a)!.milestones.map((m) => m.percent)).toEqual([0, 0, 0, 0, 0]);
      expect(both.get(a)!.current?.code).toBe("ENG");
    });

    it("a family with no milestone map, and no stage list, gets the empty state and no crash", async () => {
      const w = await world("NOMAP", { milestones: false });
      const jobId = await w.makeJob();
      const r = await loadJobMilestones(w.actor, jobId);
      expect(r).toEqual({ milestones: [], current: null, noStageList: true, unmappedPlans: 0 });
      const p = await loadPortfolio(w.actor);
      const row = p.rows.find((x) => x.id === jobId)!;
      expect([row.currentMilestone, row.milestonesComplete]).toEqual([null, false]);
    });
  });

  // ── the synthetic exchanger, end to end ───────────────────────────────────
  describe("synthetic heat-exchanger family", () => {
    it("createJob (flag on) schedules two equipment types, shell-side and tube-side hydro, and rolls up to milestones", async () => {
      flags.multiFamilyIntake = true;
      const w = await world("HE");
      const job = await createJob(w.actor, w.input([["HE-1", "HE-2"], ["MED-1"]]));
      const lines = await owner.equipment.findMany({ where: { jobId: job.jobId }, orderBy: { id: "asc" } });
      expect(lines.map((l) => l.equipmentTypeId)).toEqual([w.typeFixed.id, w.typeMed.id]);
      await generateSchedule(w.actor, { jobId: job.jobId, mode: "FORWARD" });
      const units = await owner.unit.findMany({ where: { jobId: job.jobId }, orderBy: { id: "asc" } });
      expect(units).toHaveLength(3);

      // Nothing done: five listed milestones (the ones this job has), all 0 %, planned finish from the latest mapped plan.
      const start = (await loadJobMilestones(w.actor, job.jobId))!;
      expect(start.noStageList).toBe(true); // an exchanger has no work-order stage list today
      expect(start.unmappedPlans).toBe(0);
      expect(start.milestones.map((m) => [m.name, m.percent, m.state])).toEqual([
        ["Engineering approved", 0, "NOT_STARTED"],
        ["Material ready", 0, "NOT_STARTED"],
        ["Fabrication", 0, "NOT_STARTED"],
        ["Pressure test", 0, "NOT_STARTED"],
        ["Dispatched", 0, "NOT_STARTED"],
      ]);
      expect(start.milestones.find((m) => m.code === "TEST")!.plans).toBe(6); // shell-side and tube-side hydro, 3 units
      expect(start.milestones.every((m) => m.plannedFinish !== null)).toBe(true);

      // Office work done: the two JOB-grain plans, one each (not one per unit).
      await complete(job.jobId, "H1");
      await complete(job.jobId, "H2");
      const unitIds = units.map((u) => u.id);
      // Shell (H3, 20 d) done on every unit; tube bundle (H4, 15 d) on none: 20/35 = 57 %.
      await complete(job.jobId, "H3", unitIds);
      // Shell-side hydro (H5) on one unit of three: effort 5 each, 6 plans: 5/30 = 17 %.
      await complete(job.jobId, "H5", [unitIds[0]]);
      const mid = (await loadJobMilestones(w.actor, job.jobId))!;
      const pct = Object.fromEntries(mid.milestones.map((m) => [m.code, m.percent]));
      expect(pct).toEqual({ ENG: 100, MAT: 100, FAB: 57, TEST: 17, DISP: 0 });
      expect(mid.current?.code).toBe("FAB");

      const portfolio = await loadPortfolio(w.actor);
      const row = portfolio.rows.find((r) => r.id === job.jobId)!;
      expect([row.currentMilestone?.name, row.currentMilestone?.percent, row.milestonesComplete]).toEqual(["Fabrication", 57, false]);

      for (const p of PROCS) await complete(job.jobId, p.code);
      const done = (await loadJobMilestones(w.actor, job.jobId))!;
      expect(done.current).toBeNull();
      const row2 = (await loadPortfolio(w.actor)).rows.find((r) => r.id === job.jobId)!;
      expect([row2.currentMilestone, row2.milestonesComplete]).toEqual([null, true]);
    });

    it("a family that does have a stage list is not flagged as having none", async () => {
      const w = await world("STAGES", { stageList: true });
      const jobId = await w.makeJob();
      expect((await loadJobMilestones(w.actor, jobId))!.noStageList).toBe(false);
    });

    it("keeps a tube route's expansion (A) and grommet (B) variants apart, one per variant letter", async () => {
      const w = await world("TUBE");
      const tube = await owner.componentTypeRef.create({ data: { tenantId: w.tenantId, code: uniq("TUBE"), name: "Tube" } });
      const expansion = await owner.operationRef.create({ data: { tenantId: w.tenantId, code: uniq("EXP"), name: "Expand tube into tubesheet" } });
      const grommet = await owner.operationRef.create({ data: { tenantId: w.tenantId, code: uniq("GRM"), name: "Fit grommet" } });
      const route = async (variant: string, op: number) => {
        const r = await owner.routeTemplate.create({ data: { tenantId: w.tenantId, componentTypeId: tube.id, familyId: w.fam.id, name: `Tube ${variant}`, variant } });
        const v = await owner.routeTemplateVersion.create({ data: { routeId: r.id, version: 1 } });
        await owner.routeStep.create({ data: { routeVersionId: v.id, seq: 1, operationId: op } });
        return r;
      };
      const a = await route("A", expansion.id);
      const b = await route("B", grommet.id);
      await expect(route("A", grommet.id)).rejects.toThrow(/Unique constraint/i);
      const routes = await withTenant(w.tenantId, (tx) =>
        tx.routeTemplate.findMany({
          where: { familyId: w.fam.id, componentTypeId: tube.id },
          orderBy: { variant: "asc" },
          select: { id: true, variant: true, versions: { select: { steps: { select: { operationId: true } } } } },
        }),
      );
      expect(routes.map((r) => [r.variant, r.versions[0].steps[0].operationId])).toEqual([["A", expansion.id], ["B", grommet.id]]);
      expect([routes[0].id, routes[1].id]).toEqual([a.id, b.id]);
    });
  });
});
