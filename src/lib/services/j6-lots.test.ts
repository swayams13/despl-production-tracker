import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createJobSchema, recordWorkSchema } from "@/lib/shared/schemas";

/**
 * Lean Core J6 (D21 default Serial): a lot is one unit carrying a quantity.
 * Migration 20261028100000_j6_lots, createJob for LOT lines, recordWork with
 * detail.qty (partial Done, QTY_EXCEEDS_PLANNED, maker-checker at full
 * quantity), the quantity rollup, qtyBands stored but never applied to dates.
 * Violation cases first. DB parts gated behind RUN_DB_TESTS; every fixture is
 * its own disposable tenant (owner client bypasses RLS).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe("J6 schemas (pure)", () => {
  const line = { equipmentTypeId: null, name: "Tank", blockNo: 1, remarks: null };
  const job = (equipments: unknown[]) => ({
    clientId: 1, familyId: 1, templateVersionId: 1, jobNumber: "J", equipments,
  });
  const messages = (equipments: unknown[]) => {
    const r = createJobSchema.safeParse(job(equipments));
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it.each([
    ["a lot with no quantity", [{ ...line, trackingMode: "LOT" }], "A lot line needs its quantity"],
    ["a lot with serials", [{ ...line, trackingMode: "LOT", lotQty: 5, serials: ["A"] }], "A lot line has no serial numbers; it is counted, not serialised"],
    ["a lot of zero", [{ ...line, trackingMode: "LOT", lotQty: 0 }], null],
    ["a negative lot", [{ ...line, trackingMode: "LOT", lotQty: -3 }], null],
    ["a serial line with a lot quantity", [{ ...line, serials: ["A"], lotQty: 5 }], "A lot quantity applies to a lot line only"],
    ["a serial line with no serials (unchanged)", [{ ...line }], "Each equipment block needs at least one serial number"],
    ["duplicate serials (unchanged)", [{ ...line, serials: ["A", "A"] }], "Serial numbers must be unique within an equipment block"],
  ])("refuses %s", (_label, equipments, message) => {
    const m = messages(equipments);
    expect(m.length).toBeGreaterThan(0);
    if (message) expect(m).toContain(message);
  });

  it("accepts a lot line and a serial line with the old shape", () => {
    expect(messages([{ ...line, trackingMode: "LOT", lotQty: 40 }])).toEqual([]);
    expect(messages([{ ...line, serials: ["A", "B"] }])).toEqual([]);
  });

  it.each([[0], [-1], [1.5]])("refuses detail.qty %s on recordWork", (qty) => {
    expect(() =>
      recordWorkSchema.parse({ jobId: 1, action: "DONE", items: [{ kind: "ASSEMBLY_STEP", id: 1, detail: { qty } }] }),
    ).toThrow(ZodError);
  });
});

describe.skipIf(!RUN_DB)("Lean Core J6 lots (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { ROLES } = await import("@/lib/authz");
  const { createJob } = await import("./job-intake.service");
  const { generateSchedule } = await import("./schedule.service");
  const { recordWork } = await import("./work.service");
  const { inspect } = await import("./work.service");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;
  afterAll(async () => {
    await owner.$disconnect();
  });

  // ── createJob ──────────────────────────────────────────────────────────
  async function world() {
    const org = await owner.organization.create({ data: { code: `TEST-J6-${stamp}-${++n}`, name: "j6" } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const user = await owner.user.create({
      data: { tenantId, email: `${uniq("u")}@test.local`, username: uniq("u"), passwordHash: "x", name: "Admin", mustChangePassword: false },
    });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const fam = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: fam.id, name: "T" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    const bands = [{ maxQty: 10, multiplier: 1 }, { maxQty: 100, multiplier: 0.6 }];
    for (const [seq, finish] of [[1, 5], [2, 15]] as const) {
      await owner.templateProcess.create({
        data: {
          versionId: tv.id, seq, code: String(seq * 10), name: `P${seq}`, defaultDepartmentId: dept.id, grain: "UNIT",
          durationMinDays: 5, durationMaxDays: 5, envelopeStartByMinDays: finish - 5, envelopeStartByMaxDays: finish - 5,
          envelopeFinishByMinDays: finish, envelopeFinishByMaxDays: finish, qtyBands: seq === 2 ? bands : undefined,
        },
      });
    }
    const actor = {
      userId: user.id, tenantId, clientId: null, name: "Admin", email: user.email, roles: [ROLES.ADMIN],
      departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false,
    };
    const make = (equipments: unknown[]) =>
      createJob(actor, {
        clientId: client.id, familyId: fam.id, templateVersionId: tv.id, calendarId: null, jobNumber: uniq("J6"),
        clientOrderNo: null, projectName: null, poRef: null, designCode: null, orderDate: new Date("2026-11-02"),
        committedDeliveryDate: null, targetDispatchDate: null, priority: "NORMAL", remarks: null,
        excludedProcessCodes: [], exclusionReason: null, qcpTemplateSourceId: null, copyBomFromEquipmentId: null,
        equipments,
      } as never);
    return { tenantId, actor, make, bands };
  }
  const base = { equipmentTypeId: null, remarks: null };

  describe("createJob", () => {
    it("refuses LOT_THEN_SERIAL until D21 picks it, writing nothing", async () => {
      const w = await world();
      await expect(
        w.make([{ ...base, name: "Tank", blockNo: 1, trackingMode: "LOT_THEN_SERIAL", serials: ["A"] }]),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/not available yet/i) });
      expect(await owner.job.count({ where: { tenantId: w.tenantId } })).toBe(0);
    });

    it("makes one unit per LOT line carrying its quantity, next to a serial line that is unchanged", async () => {
      const w = await world();
      const r = await w.make([
        { ...base, name: "Receiver", blockNo: 1, serials: ["SR01", "SR02"] },
        { ...base, name: "Tank", blockNo: 2, trackingMode: "LOT", lotQty: 40 },
      ]);
      expect(r.unitCount).toBe(3);
      const units = await owner.unit.findMany({ where: { jobId: r.jobId }, include: { equipment: true }, orderBy: { id: "asc" } });
      expect(units.map((u) => [u.equipment.trackingMode, u.qtyPlanned])).toEqual([["SERIAL", 1], ["SERIAL", 1], ["LOT", 40]]);
      expect(units[2].serialNo).toMatch(/-LOT2$/);
      // bands are copied to the job's processes
      const jp = await owner.jobProcess.findMany({ where: { jobId: r.jobId, code: "20" } });
      expect(jp[0].qtyBands).toEqual(w.bands);
    });

    it("gives a lot's plans its quantity and a serial unit's none; a reschedule keeps the count done", async () => {
      const w = await world();
      const r = await w.make([
        { ...base, name: "Receiver", blockNo: 1, serials: ["SR01"] },
        { ...base, name: "Tank", blockNo: 2, trackingMode: "LOT", lotQty: 40 },
      ]);
      await generateSchedule(w.actor, { jobId: r.jobId, mode: "FORWARD" });
      const plans = () =>
        owner.processPlan.findMany({ where: { jobId: r.jobId, scheduleRun: { isCurrent: true } }, include: { unit: { include: { equipment: true } } } });
      const rows = await plans();
      for (const p of rows) expect(p.qtyPlanned).toBe(p.unit!.equipment.trackingMode === "LOT" ? 40 : null);
      const lotPlan = rows.find((p) => p.qtyPlanned != null && p.jobProcessId)!;
      await recordWork(w.actor, { jobId: r.jobId, action: "DONE", items: [{ kind: "PROCESS_PLAN", id: lotPlan.id, detail: { qty: 15 } }] });
      await generateSchedule(w.actor, { jobId: r.jobId, mode: "FORWARD" });
      const after = (await plans()).find((p) => p.unitId === lotPlan.unitId && p.jobProcessId === lotPlan.jobProcessId)!;
      expect([after.qtyDone, after.qtyPlanned, after.status]).toEqual([15, 40, "IN_PROGRESS"]);
    });
  });

  // ── recordWork on a lot ───────────────────────────────────────────────
  describe("recordWork with detail.qty", async () => {
    const o = await makeWorkOrg(owner, "J6");
    const sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    const sup2 = await o.user("sup2", ["SUPERVISOR"], [o.fab.id]);
    const qc = await o.user("qc", ["QC"]);

    /** One lot unit (qty 10) with two steps on process 20, a plan for it, and one serial unit alongside. */
    async function lotJob(opts: { requiresQc?: boolean } = {}) {
      const j = await o.job({
        units: 2,
        processes: [{ code: "20" }],
        steps: [
          { seq: 1, processSeq: 20, requiresQc: opts.requiresQc ?? true },
          { seq: 2, processSeq: 20, requiresQc: opts.requiresQc ?? true },
        ],
        components: [{ tag: "Plate", ops: [{ code: "CUTTING", requiresQc: opts.requiresQc ?? true }] }],
      });
      await owner.equipment.update({ where: { id: j.equipment.id }, data: { trackingMode: "LOT" } });
      // unit 0 is the lot; unit 1 stays a serial unit of the same line only for the "qty on serial" case
      await owner.unit.update({ where: { id: j.units[0].id }, data: { qtyPlanned: 10 } });
      await owner.assemblyStep.updateMany({ where: { unitId: j.units[0].id }, data: { qtyPlanned: 10 } });
      await owner.processPlan.updateMany({ where: { unitId: j.units[0].id }, data: { qtyPlanned: 10 } });
      await owner.componentOperation.updateMany({ where: { component: { unitId: j.units[0].id } }, data: { qtyPlanned: 10 } });
      return j;
    }
    const done = (a: typeof sup, j: Awaited<ReturnType<typeof lotJob>>, id: number, qty?: number, kind: "ASSEMBLY_STEP" | "COMPONENT_OP" = "ASSEMBLY_STEP") =>
      recordWork(a, { jobId: j.job.id, action: "DONE", items: [{ kind, id, detail: qty == null ? undefined : { qty } }] });
    const step = (id: number) => owner.assemblyStep.findUniqueOrThrow({ where: { id } });

    it("refuses more than is left with QTY_EXCEEDS_PLANNED, and writes nothing", async () => {
      const j = await lotJob();
      const s = j.step(1);
      await done(sup, j, s, 6);
      const r = await done(sup, j, s, 5);
      expect(r.refused[0]).toMatchObject({ code: "QTY_EXCEEDS_PLANNED", meta: { qtyPlanned: 10, qtyDone: 6, qty: 5 } });
      expect((await step(s)).qtyDone).toBe(6);
    });

    it("refuses a quantity on a serial step, on START, and an explicit qtyGood on a lot operation", async () => {
      const j = await lotJob();
      // unit 1 is a serial row: no qtyPlanned
      const serialStep = j.step(1, 1);
      const r1 = await done(sup, j, serialStep, 1);
      expect(r1.refused[0].code).toBe("VALIDATION_FAILED");
      const r2 = await recordWork(sup, { jobId: j.job.id, action: "START", items: [{ kind: "ASSEMBLY_STEP", id: j.step(1), detail: { qty: 2 } }] });
      expect(r2.refused[0].code).toBe("VALIDATION_FAILED");
      const r3 = await recordWork(sup, {
        jobId: j.job.id, action: "DONE", items: [{ kind: "COMPONENT_OP", id: j.op("Plate", "CUTTING"), detail: { qtyGood: 3 } }],
      });
      expect(r3.refused[0].code).toBe("VALIDATION_FAILED");
      expect((await step(j.step(1))).status).toBe("NOT_STARTED");
    });

    it("counts partial Dones: IN_PROGRESS, one audit row per write with a server recordedAt, then the last piece submits", async () => {
      const j = await lotJob();
      const s = j.step(1);
      const r1 = await done(sup, j, s, 4);
      expect(r1.applied[0]).toMatchObject({ from: "NOT_STARTED", to: "IN_PROGRESS" });
      const r2 = await done(sup2, j, s, 3);
      expect(r2.applied[0]).toMatchObject({ from: "IN_PROGRESS", to: "IN_PROGRESS" });
      let row = await step(s);
      expect([row.status, row.qtyDone, row.submittedBy, row.reportedFinishAt]).toEqual(["IN_PROGRESS", 7, null, null]);
      // the last piece: omitted qty means all that is left
      const r3 = await done(sup, j, s);
      expect(r3.applied[0]).toMatchObject({ to: "SUBMITTED" });
      row = await step(s);
      expect([row.status, row.qtyDone, row.submittedBy]).toEqual(["SUBMITTED", 10, sup.userId]);

      const trail = await owner.auditLog.findMany({
        where: { tenantId: o.tenantId, entityType: "AssemblyStep", entityId: String(s), action: "work.done" },
        orderBy: { id: "asc" },
      });
      expect(trail.map((t) => (t.after as { qty: { added: number; done: number; partial: boolean } }).qty)).toEqual([
        expect.objectContaining({ added: 4, done: 4, partial: true }),
        expect.objectContaining({ added: 3, done: 7, partial: true }),
        expect.objectContaining({ added: 3, done: 10, partial: false }),
      ]);
      for (const t of trail) expect((t.after as { recordedAt?: string }).recordedAt).toBeTruthy();
    });

    it("skips the finish-time gates on a partial Done (late reason) and applies them on the last piece", async () => {
      const j = await o.job({ units: 1, processes: [{ code: "20", plannedFinish: new Date(Date.now() - 3 * 86_400_000) }], steps: [{ seq: 1, processSeq: 20, requiresQc: false }] });
      await owner.equipment.update({ where: { id: j.equipment.id }, data: { trackingMode: "LOT" } });
      await owner.unit.update({ where: { id: j.units[0].id }, data: { qtyPlanned: 10 } });
      await owner.assemblyStep.updateMany({ where: { unitId: j.units[0].id }, data: { qtyPlanned: 10 } });
      const s = j.step(1);
      const partial = await done(sup, j, s, 4);
      expect(partial.refused).toEqual([]);
      const last = await done(sup, j, s);
      expect(last.refused[0].code).toBe("LATE_REASON_REQUIRED");
      expect((await step(s)).qtyDone).toBe(4);
    });

    it("keeps maker-checker at full quantity: the recorder of the last piece cannot verify, QC can", async () => {
      const j = await lotJob();
      const s = j.step(1);
      await done(sup, j, s, 5);
      await done(sup, j, s, 5);
      // a QC user who recorded the work may not accept it
      const recorder = await o.user("qc-recorder", ["QC", "SUPERVISOR"], [o.fab.id]);
      const j2 = await lotJob();
      await done(recorder, j2, j2.step(1), 10);
      await expect(inspect(recorder, { kind: "ASSEMBLY_STEP", targetId: j2.step(1), result: "ACCEPT" })).rejects.toMatchObject({
        code: "MAKER_CHECKER_VIOLATION",
      });
      const ok = await inspect(qc, { kind: "ASSEMBLY_STEP", targetId: s, result: "ACCEPT" });
      expect(ok.to).toBe("COMPLETE");
    });

    it("counts a lot operation through qtyGood and completes it at the full quantity", async () => {
      const j = await lotJob({ requiresQc: false });
      const op = j.op("Plate", "CUTTING");
      const r1 = await done(sup, j, op, 6, "COMPONENT_OP");
      expect(r1.applied[0].to).toBe("IN_PROGRESS");
      expect((await owner.componentOperation.findUniqueOrThrow({ where: { id: op } })).qtyGood).toBe(6);
      const over = await done(sup, j, op, 5, "COMPONENT_OP");
      expect(over.refused[0].code).toBe("QTY_EXCEEDS_PLANNED");
      const r2 = await done(sup, j, op, 4, "COMPONENT_OP");
      expect(r2.applied[0].to).toBe("COMPLETE");
    });

    it("rolls the plan's quantity up as the minimum over its mapped steps, and completes at full quantity", async () => {
      const j = await lotJob({ requiresQc: false });
      const plan = j.plan("20", 0);
      const planRow = () => owner.processPlan.findUniqueOrThrow({ where: { id: plan } });
      await done(sup, j, j.step(1), 8);
      // step 2 starts while step 1 is still open: a SOFT order, so it takes a supervisor's reason
      const early = await recordWork(sup, {
        jobId: j.job.id, action: "DONE", items: [{ kind: "ASSEMBLY_STEP", id: j.step(2), detail: { qty: 5 } }],
        override: { category: "CREW_OR_MACHINE_FREE" },
      });
      expect(early.refused).toEqual([]);
      expect(await planRow()).toMatchObject({ qtyDone: 5, qtyPlanned: 10, status: "IN_PROGRESS" });
      await done(sup, j, j.step(2), 5);
      expect(await planRow()).toMatchObject({ qtyDone: 8, status: "IN_PROGRESS" });
      await done(sup, j, j.step(1), 2);
      expect(await planRow()).toMatchObject({ qtyDone: 10, status: "COMPLETE" });
    });

    it("leaves a serial job exactly as before: rows carry no quantity, a plain Done completes", async () => {
      const j = await o.job({ units: 1, processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20, requiresQc: false }] });
      const row = await step(j.step(1));
      expect([row.qtyPlanned, row.qtyDone]).toEqual([null, 0]);
      expect((await owner.processPlan.findUniqueOrThrow({ where: { id: j.plan("20", 0) } })).qtyPlanned).toBeNull();
      const r = await done(sup, j, j.step(1));
      expect(r.applied[0].to).toBe("COMPLETE");
      expect((await step(j.step(1))).qtyDone).toBe(0);
    });

    it("refuses a plan quantity beyond planned at the database (CHECK)", async () => {
      const j = await lotJob();
      await expect(owner.assemblyStep.update({ where: { id: j.step(1) }, data: { qtyDone: 11 } })).rejects.toThrow(/assembly_steps_qty_check|check constraint/i);
      await expect(owner.unit.update({ where: { id: j.units[0].id }, data: { qtyPlanned: 0 } })).rejects.toThrow(/units_qty_planned_check|check constraint/i);
    });
  });
});
