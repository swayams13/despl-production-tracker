import { afterAll, describe, expect, it } from "vitest";

/**
 * Lean Core J4a — planned joints and scoped assembly steps.
 * Proves migration 20261022100000_j4a_planned_joints (scope CHECK, joint uniqueness,
 * same-job trigger, RLS) and the behaviour of createJob / the materialiser: seams
 * generated from shell_courses, PER_JOINT and PER_COMPONENT steps expanded with stable
 * seqs, one shared checkpoint cleared only when its last joint is complete, the gate by
 * the row's own seq, weld records bound to their planned joint, and the DESPL-320-style
 * backfill. A route with no scoped step must stay exactly as it was.
 * Violation cases first, per CLAUDE.md. Gated behind RUN_DB_TESTS; every fixture is its
 * own disposable tenant (owner client bypasses RLS).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core J4a planned joints (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { ROLES } = await import("@/lib/authz");
  const { createJob } = await import("./job-intake.service");
  const { verifyAssemblyStep, startAssemblyStep, submitAssemblyStep, materializeAssemblyStepsFromTemplate } = await import("./assembly.service");
  const { backfillPlannedJoints } = await import("./planned-joint.setup");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;

  type Step = {
    scope?: "PER_UNIT" | "PER_JOINT" | "PER_COMPONENT";
    jointType?: "LONG_SEAM" | "CIRC_SEAM" | "NOZZLE" | "ATTACHMENT";
    componentTypeId?: number;
    kind: "WORK" | "INSPECTION";
    activity: string;
    srNo: string;
    jointRef?: string;
  };
  const JOINT_STEPS: Step[] = [
    { kind: "WORK", activity: "Prep", srNo: "1" },
    { scope: "PER_JOINT", jointType: "LONG_SEAM", kind: "WORK", activity: "Weld long seam", srNo: "2" },
    { scope: "PER_JOINT", jointType: "LONG_SEAM", kind: "INSPECTION", activity: "NDT long seam", srNo: "3" },
    { scope: "PER_JOINT", jointType: "CIRC_SEAM", kind: "WORK", activity: "Weld circ seam", srNo: "4" },
    { kind: "INSPECTION", activity: "Final", srNo: "5" },
  ];
  const PLAIN_STEPS: Step[] = [
    { kind: "WORK", activity: "Prep", srNo: "1" },
    { kind: "WORK", activity: "Weld", srNo: "2", jointRef: "LS-1" },
    { kind: "INSPECTION", activity: "Final", srNo: "5" },
  ];

  /** A disposable tenant with a family, a 1-process route, an assembly template, a library QCP and the shell_courses question. */
  async function world(label: string, steps: Step[] | null = JOINT_STEPS) {
    const org = await owner.organization.create({ data: { code: `TEST-J4A-${label}-${stamp}-${++n}`, name: `j4a ${label}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const user = await owner.user.create({
      data: { tenantId, email: `${uniq("u")}@test.local`, username: uniq("u"), passwordHash: "x", name: "Admin", mustChangePassword: false },
    });
    const worker = await owner.user.create({
      data: { tenantId, email: `${uniq("w")}@test.local`, username: uniq("w"), passwordHash: "x", name: "Worker", mustChangePassword: false },
    });
    const qcUser = await owner.user.create({
      data: { tenantId, email: `${uniq("q")}@test.local`, username: uniq("q"), passwordHash: "x", name: "QC", mustChangePassword: false },
    });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    await owner.templateProcess.create({ data: { versionId: tv.id, seq: 1, code: "10", name: "Process 10", defaultDepartmentId: dept.id } });
    const compType = await owner.componentTypeRef.create({ data: { tenantId, code: "NOZ", name: "Nozzle" } });

    const addTemplate = async (familyId: number, list: Step[]) => {
      const asm = await owner.assemblyTemplate.create({ data: { tenantId, familyId, name: uniq("A") } });
      const av = await owner.assemblyTemplateVersion.create({ data: { templateId: asm.id, version: 1, status: "PUBLISHED", publishedAt: new Date() } });
      for (const [i, st] of list.entries()) {
        await owner.assemblyTemplateStep.create({
          data: {
            versionId: av.id,
            seq: i + 1,
            groupCode: "A",
            groupName: "A",
            srNo: st.srNo,
            activity: st.activity,
            kind: st.kind,
            defaultDepartmentId: dept.id,
            qcpSrNo: st.kind === "INSPECTION" ? st.srNo : null,
            scope: st.scope ?? "PER_UNIT",
            jointType: st.jointType ?? null,
            componentTypeId: st.componentTypeId ?? null,
            jointRef: st.jointRef ?? null,
          },
        });
      }
      return av;
    };
    if (steps) await addTemplate(family.id, steps);

    const qcp = await owner.qcpTemplate.create({ data: { tenantId, jobLabel: "LIB", vessel: "V" } });
    for (const [i, srNo] of ["3", "5"].entries()) {
      await owner.qcpItem.create({ data: { tenantId, qcpTemplateId: qcp.id, sequence: i + 1, srNo, kind: "CHECKPOINT", activity: `qcp ${srNo}` } });
    }
    await owner.configQuestion.create({ data: { tenantId, familyId: family.id, key: "shell_courses", label: "Shell courses", type: "NUMBER" } });

    const mkActor = (u: { id: number; email: string }, roles: string[]) => ({
      userId: u.id, tenantId, clientId: null, name: "x", email: u.email, roles: roles as never, departmentIds: [],
      mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false,
    });
    const actor = mkActor(user, [ROLES.ADMIN]);
    const qcActor = mkActor(qcUser, [ROLES.QC]);
    const make = (opts: { courses?: number | null; serials?: string[]; jobNumber?: string } = {}) =>
      createJob(actor, {
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        calendarId: null,
        jobNumber: opts.jobNumber ?? uniq("J4A"),
        clientOrderNo: null,
        projectName: null,
        poRef: null,
        designCode: null,
        orderDate: null,
        committedDeliveryDate: null,
        targetDispatchDate: null,
        priority: "NORMAL",
        remarks: null,
        excludedProcessCodes: [],
        exclusionReason: null,
        equipments: [
          {
            equipmentTypeId: null,
            name: "Vessel",
            blockNo: 1,
            remarks: null,
            config: opts.courses === undefined || opts.courses === null ? null : { shell_courses: opts.courses },
            serials: opts.serials ?? ["S1"],
          },
        ],
        qcpTemplateSourceId: qcp.id,
        copyBomFromEquipmentId: null,
      } as never);
    return { tenantId, org, dept, user, worker, qcUser, family, compType, qcp, actor, qcActor, make, addTemplate };
  }

  const stepsOf = (jobId: number, unitId?: number) =>
    owner.assemblyStep.findMany({
      where: { jobId, ...(unitId ? { unitId } : {}) },
      orderBy: [{ unitId: "asc" }, { seq: "asc" }],
      include: { templateStep: true },
    });

  afterAll(async () => {
    await owner.$disconnect();
  });

  // ── violation cases first ─────────────────────────────────────────────────
  describe("assembly_template_steps scope CHECK", () => {
    it.each([
      ["PER_JOINT without a joint type", { scope: "PER_JOINT" as const }],
      ["PER_UNIT with a joint type", { scope: "PER_UNIT" as const, jointType: "LONG_SEAM" as const }],
      ["PER_JOINT with a literal joint ref", { scope: "PER_JOINT" as const, jointType: "LONG_SEAM" as const, jointRef: "LS-1" }],
      ["PER_COMPONENT without a component type", { scope: "PER_COMPONENT" as const }],
      ["PER_JOINT with a component type", { scope: "PER_JOINT" as const, jointType: "LONG_SEAM" as const, withComponent: true }],
    ])("refuses %s", async (_l, extra) => {
      const w = await world("CHK", null);
      const av = await w.addTemplate(w.family.id, []);
      const { withComponent, ...rest } = extra as typeof extra & { withComponent?: boolean };
      await expect(
        owner.assemblyTemplateStep.create({
          data: {
            versionId: av.id, seq: 1, groupCode: "A", groupName: "A", srNo: "1", activity: "x", kind: "WORK",
            defaultDepartmentId: w.dept.id,
            ...rest,
            ...(withComponent ? { componentTypeId: w.compType.id } : {}),
          } as never,
        }),
      ).rejects.toThrow(/assembly_template_steps_scope_chk|check constraint/i);
    });
  });

  describe("planned_joints constraints", () => {
    it("refuses a duplicate joint number on one line, but allows it on another line", async () => {
      const w = await world("DUP");
      const j1 = await w.make({ courses: 1 });
      const j2 = await w.make({ courses: 1 });
      const eq1 = await owner.equipment.findFirstOrThrow({ where: { jobId: j1.jobId } });
      const eq2 = await owner.equipment.findFirstOrThrow({ where: { jobId: j2.jobId } });
      await expect(
        owner.plannedJoint.create({ data: { jobId: j1.jobId, equipmentId: eq1.id, jointNo: "LS-1", jointType: "LONG_SEAM", source: "IMPORTED" } }),
      ).rejects.toThrow(/Unique constraint/i);
      expect(await owner.plannedJoint.count({ where: { equipmentId: eq2.id, jointNo: "LS-1" } })).toBe(1);
    });

    it("refuses a line that belongs to another job (trigger)", async () => {
      const w = await world("SAMEJOB");
      const j1 = await w.make({ courses: 1 });
      const j2 = await w.make({ courses: 1 });
      const eq2 = await owner.equipment.findFirstOrThrow({ where: { jobId: j2.jobId } });
      await expect(
        owner.plannedJoint.create({ data: { jobId: j1.jobId, equipmentId: eq2.id, jointNo: "X-1", jointType: "ATTACHMENT", source: "IMPORTED" } }),
      ).rejects.toThrow(/does not belong to job/i);
    });

    it.each(["", " ", " LS-9", "LS-9 "])("refuses the joint number %j (CHECK)", async (jointNo) => {
      const w = await world("NO");
      const j = await w.make({ courses: 1 });
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: j.jobId } });
      await expect(
        owner.plannedJoint.create({ data: { jobId: j.jobId, equipmentId: eq.id, jointNo, jointType: "ATTACHMENT", source: "IMPORTED" } }),
      ).rejects.toThrow(/planned_joints_joint_no_chk|check constraint/i);
    });

    it("a tenant cannot read another tenant's planned joints", async () => {
      const a = await world("ISO-A");
      const b = await world("ISO-B");
      const j = await a.make({ courses: 2 });
      expect(await withTenant(b.tenantId, (tx) => tx.plannedJoint.count({ where: { jobId: j.jobId } }))).toBe(0);
      expect(await withTenant(a.tenantId, (tx) => tx.plannedJoint.count({ where: { jobId: j.jobId } }))).toBe(5);
    });
  });

  describe("createJob refusals", () => {
    it.each([
      ["no answer", null],
      ["zero courses", 0],
      ["too many courses", 31],
      ["a fractional count", 1.5],
    ])("refuses a route with seam-driven steps and %s, and writes nothing", async (_l, courses) => {
      const w = await world("NOANS");
      const jobNumber = uniq("NOANS");
      await expect(w.make({ courses: courses as number | null, jobNumber })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(await owner.job.count({ where: { tenantId: w.tenantId, jobNumber } })).toBe(0);
      expect(await owner.plannedJoint.count({ where: { tenantId: w.tenantId } })).toBe(0);
    });
  });

  // ── generation and expansion ──────────────────────────────────────────────
  describe("two shell courses, two units", () => {
    it("generates LS-1..2 and CS-1..3, expands the scoped steps per unit with unique rising seqs", async () => {
      const w = await world("EXP");
      const r = await w.make({ courses: 2, serials: ["S1", "S2"] });
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
      const joints = await owner.plannedJoint.findMany({ where: { equipmentId: eq.id }, orderBy: { sortOrder: "asc" } });
      expect(joints.map((j) => j.jointNo)).toEqual(["LS-1", "LS-2", "CS-1", "CS-2", "CS-3"]);
      expect(joints.every((j) => j.source === "GENERATED" && j.confirmed === false)).toBe(true);

      expect(r.assemblyStepCount).toBe(18); // 9 per unit
      const units = await owner.unit.findMany({ where: { jobId: r.jobId }, orderBy: { id: "asc" } });
      for (const u of units) {
        const rows = await stepsOf(r.jobId, u.id);
        expect(rows.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(rows.map((s) => `${s.templateStep.activity}|${s.jointRef ?? ""}`)).toEqual([
          "Prep|", "Weld long seam|LS-1", "Weld long seam|LS-2", "NDT long seam|LS-1", "NDT long seam|LS-2",
          "Weld circ seam|CS-1", "Weld circ seam|CS-2", "Weld circ seam|CS-3", "Final|",
        ]);
        // each expanded row names its planned joint; plain steps do not
        for (const s of rows) {
          expect(s.plannedJointId == null).toBe(s.jointRef == null);
          if (s.plannedJointId != null) expect(joints.find((j) => j.id === s.plannedJointId)!.jointNo).toBe(s.jointRef);
        }
      }
    });

    it("binds the two long-seam inspections of a unit to the one checkpoint, and the final inspection to its own", async () => {
      const w = await world("QCP");
      const r = await w.make({ courses: 2 });
      const rows = await stepsOf(r.jobId);
      const ndt = rows.filter((s) => s.templateStep.activity === "NDT long seam");
      expect(ndt).toHaveLength(2);
      expect(ndt[0].qcpItemId).not.toBeNull();
      expect(ndt[0].qcpItemId).toBe(ndt[1].qcpItemId);
      const fin = rows.find((s) => s.templateStep.activity === "Final")!;
      expect(fin.qcpItemId).not.toBeNull();
      expect(fin.qcpItemId).not.toBe(ndt[0].qcpItemId);
      expect(rows.filter((s) => s.templateStep.kind === "WORK").every((s) => s.qcpItemId == null)).toBe(true);
    });
  });

  describe("a route with no scoped step is exactly as before", () => {
    it("keeps the template seq, writes no planned joints, and needs no answer", async () => {
      const w = await world("PLAIN", PLAIN_STEPS);
      const r = await w.make(); // no shell_courses
      const rows = await stepsOf(r.jobId);
      expect(rows.map((s) => s.seq)).toEqual([1, 2, 3]);
      expect(rows.map((s) => s.templateStep.seq)).toEqual([1, 2, 3]);
      expect(rows.map((s) => s.jointRef)).toEqual([null, "LS-1", null]); // the literal joint ref is copied, as before
      expect(rows.every((s) => s.plannedJointId == null && s.componentId == null)).toBe(true);
      expect(await owner.plannedJoint.count({ where: { tenantId: w.tenantId } })).toBe(0);
    });
  });

  // ── a shared checkpoint clears only when its last joint is complete ───────
  describe("QC clearance of a shared checkpoint", () => {
    it("records ACCEPTED only when the last joint's inspection is verified", async () => {
      const w = await world("GATE");
      const r = await w.make({ courses: 2 });
      const unit = await owner.unit.findFirstOrThrow({ where: { jobId: r.jobId } });
      const ndt = (await stepsOf(r.jobId)).filter((s) => s.templateStep.activity === "NDT long seam");
      const item = ndt[0].qcpItemId!;
      for (const s of ndt) await owner.assemblyStep.update({ where: { id: s.id }, data: { status: "SUBMITTED", submittedBy: w.worker.id } });

      await verifyAssemblyStep(w.qcActor, { assemblyStepId: ndt[0].id });
      expect(await owner.qcpExecution.count({ where: { qcpItemId: item, unitId: unit.id } })).toBe(0); // LS-2 still open: hold stays
      await verifyAssemblyStep(w.qcActor, { assemblyStepId: ndt[1].id });
      const execs = await owner.qcpExecution.findMany({ where: { qcpItemId: item, unitId: unit.id } });
      expect(execs.map((e) => e.result)).toEqual(["ACCEPTED"]);
    });

    it("a single-row checkpoint still records at verify, as before", async () => {
      const w = await world("SINGLE");
      const r = await w.make({ courses: 1 });
      const unit = await owner.unit.findFirstOrThrow({ where: { jobId: r.jobId } });
      const fin = (await stepsOf(r.jobId)).find((s) => s.templateStep.activity === "Final")!;
      await owner.assemblyStep.update({ where: { id: fin.id }, data: { status: "SUBMITTED", submittedBy: w.worker.id } });
      await verifyAssemblyStep(w.qcActor, { assemblyStepId: fin.id });
      expect(await owner.qcpExecution.count({ where: { qcpItemId: fin.qcpItemId!, unitId: unit.id, result: "ACCEPTED" } })).toBe(1);
    });
  });

  describe("sequence gate by the row's own seq", () => {
    it("a row starts only after the row before it on that unit is complete", async () => {
      const w = await world("SEQ");
      const r = await w.make({ courses: 2 });
      const rows = await stepsOf(r.jobId);
      const bySeq = (seq: number) => rows.find((s) => s.seq === seq)!;
      await owner.assemblyStep.updateMany({ where: { id: { in: [bySeq(1).id, bySeq(2).id] } }, data: { status: "COMPLETE" } });
      // seq 4 (first NDT) follows seq 3 (second weld), which is not complete
      await expect(startAssemblyStep(w.actor, { assemblyStepId: bySeq(4).id })).rejects.toMatchObject({
        code: "GATING_BLOCKED",
        detail: { blockedBySeq: 3 },
      });
      await owner.assemblyStep.update({ where: { id: bySeq(3).id }, data: { status: "COMPLETE" } });
      await expect(startAssemblyStep(w.actor, { assemblyStepId: bySeq(4).id })).resolves.toMatchObject({ status: "IN_PROGRESS" });
    });
  });

  describe("weld records follow the planned joint", () => {
    it("a new joint on an expanded weld step takes the step's joint number and links its planned joint", async () => {
      const w = await world("WELD");
      const r = await w.make({ courses: 1 });
      const welder = await owner.welder.create({ data: { tenantId: w.tenantId, name: "W1", employeeCode: uniq("E") } });
      const rows = await stepsOf(r.jobId);
      const weld = rows.find((s) => s.templateStep.activity === "Weld long seam")!;
      await owner.assemblyStep.updateMany({ where: { unitId: weld.unitId, seq: { lt: weld.seq } }, data: { status: "COMPLETE" } });
      await startAssemblyStep(w.actor, { assemblyStepId: weld.id });
      await submitAssemblyStep(w.actor, {
        assemblyStepId: weld.id,
        performedByWelderId: welder.id,
        newJoint: { jointNo: "WRONG-9", jointType: "Long seam", welderIds: [welder.id] },
      } as never);
      const bound = await owner.assemblyStep.findUniqueOrThrow({ where: { id: weld.id }, include: { weldJoint: true } });
      expect(bound.weldJoint).toMatchObject({ jointNo: "LS-1", plannedJointId: weld.plannedJointId });
    });

    it("linking a planned joint by the backfill does not create the binding requirement either", async () => {
      const w = await world("LINKED", [
        { kind: "WORK", activity: "Prep", srNo: "1" },
        { kind: "WORK", activity: "Fit up", srNo: "2" },
      ]);
      const r = await w.make();
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
      const fit = (await stepsOf(r.jobId)).find((s) => s.templateStep.activity === "Fit up")!;
      await owner.assemblyStep.update({ where: { id: fit.id }, data: { jointRef: "LS-1" } });
      await owner.$transaction((tx) => backfillPlannedJoints(tx as never, w.tenantId, { apply: true }));
      const linked = await owner.assemblyStep.findUniqueOrThrow({ where: { id: fit.id } });
      expect(linked.plannedJointId).not.toBeNull();
      expect(await owner.plannedJoint.count({ where: { equipmentId: eq.id } })).toBe(1);
      await owner.assemblyStep.updateMany({ where: { unitId: fit.unitId, seq: { lt: fit.seq } }, data: { status: "COMPLETE" } });
      await startAssemblyStep(w.actor, { assemblyStepId: fit.id });
      await expect(submitAssemblyStep(w.actor, { assemblyStepId: fit.id } as never)).resolves.toMatchObject({ status: "SUBMITTED" });
    });

    it("a row-level jointRef alone (the floor-facts copy) does not create the binding requirement", async () => {
      const w = await world("ROWREF", [
        { kind: "WORK", activity: "Prep", srNo: "1" },
        { kind: "WORK", activity: "Fit up", srNo: "2" },
      ]);
      const r = await w.make();
      const fit = (await stepsOf(r.jobId)).find((s) => s.templateStep.activity === "Fit up")!;
      await owner.assemblyStep.update({ where: { id: fit.id }, data: { jointRef: "J1" } }); // as the L1.2c backfill leaves some rows
      await owner.assemblyStep.updateMany({ where: { unitId: fit.unitId, seq: { lt: fit.seq } }, data: { status: "COMPLETE" } });
      await startAssemblyStep(w.actor, { assemblyStepId: fit.id });
      await expect(submitAssemblyStep(w.actor, { assemblyStepId: fit.id } as never)).resolves.toMatchObject({ status: "SUBMITTED" });
    });

    it("a weld step with a joint ref still needs a joint bound before it can be submitted", async () => {
      const w = await world("NOBIND");
      const r = await w.make({ courses: 1 });
      const weld = (await stepsOf(r.jobId)).find((s) => s.templateStep.activity === "Weld long seam")!;
      await owner.assemblyStep.updateMany({ where: { unitId: weld.unitId, seq: { lt: weld.seq } }, data: { status: "COMPLETE" } });
      await startAssemblyStep(w.actor, { assemblyStepId: weld.id });
      await expect(submitAssemblyStep(w.actor, { assemblyStepId: weld.id } as never)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  // ── PER_COMPONENT ─────────────────────────────────────────────────────────
  describe("PER_COMPONENT steps", () => {
    it("expands per component of the type on each unit, none where a unit has none", async () => {
      const w = await world("COMP", null);
      const other = await owner.productFamily.create({ data: { tenantId: w.tenantId, code: "OTHER", name: "Other" } });
      await w.addTemplate(other.id, [
        { kind: "WORK", activity: "Prep", srNo: "1" },
        { scope: "PER_COMPONENT", componentTypeId: w.compType.id, kind: "WORK", activity: "Fit nozzle", srNo: "2" },
        { kind: "WORK", activity: "Close", srNo: "3" },
      ]);
      const r = await w.make({ serials: ["U1", "U2"] });
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
      const units = await owner.unit.findMany({ where: { jobId: r.jobId }, orderBy: { id: "asc" } });
      for (const tag of ["N1", "N2"]) {
        await owner.component.create({ data: { equipmentId: eq.id, unitId: units[0].id, tag, componentTypeId: w.compType.id, jobId: r.jobId } });
      }
      await withTenant(w.tenantId, (tx) =>
        materializeAssemblyStepsFromTemplate(tx, w.tenantId, r.jobId, other.id, units.map((u) => u.id), null, null, null, [], eq.id, {}),
      );
      const u1 = await stepsOf(r.jobId, units[0].id);
      expect(u1.map((s) => `${s.seq}:${s.templateStep.activity}`)).toEqual(["1:Prep", "2:Fit nozzle", "3:Fit nozzle", "4:Close"]);
      expect(u1.filter((s) => s.componentId != null)).toHaveLength(2);
      const u2 = await stepsOf(r.jobId, units[1].id);
      expect(u2.map((s) => `${s.seq}:${s.templateStep.activity}`)).toEqual(["1:Prep", "3:Close"]); // a step that expands to nothing leaves a gap
    });
  });

  // ── backfill of literal joint numbers (DESPL-320's shape) ─────────────────
  describe("backfillPlannedJoints", () => {
    it("derives joints from literal refs, links single-joint steps and weld records, leaves comma lists alone, and is idempotent", async () => {
      const w = await world("BACKFILL", [
        { kind: "WORK", activity: "Weld LS", srNo: "1", jointRef: "LS-1" },
        { kind: "WORK", activity: "Weld CS", srNo: "2", jointRef: "CS-1" },
        { kind: "WORK", activity: "Weld nozzles", srNo: "3", jointRef: "NS-M1,NS-N1" },
        { kind: "WORK", activity: "Skirt", srNo: "4", jointRef: "SK-1" },
      ]);
      const r = await w.make({ serials: ["S1", "S2"] });
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
      const units = await owner.unit.findMany({ where: { jobId: r.jobId } });
      const logger = w.user.id;
      await owner.weldJoint.create({ data: { jobId: r.jobId, unitId: units[0].id, jointNo: "LS-1", jointType: "Long seam", loggedBy: logger } });
      await owner.weldJoint.create({ data: { jobId: r.jobId, unitId: units[1].id, jointNo: "ZZ-9", jointType: "Weld joint", loggedBy: logger } });

      const run = (apply: boolean) =>
        owner.$transaction((tx) => backfillPlannedJoints(tx as never, w.tenantId, { apply, audit: true, auditSource: "j4a test" }));
      const dry = await run(false);
      expect(dry.jointsToCreate.map((j) => `${j.jointNo}:${j.jointType}`).sort()).toEqual(
        ["CS-1:CIRC_SEAM", "LS-1:LONG_SEAM", "NS-M1:NOZZLE", "NS-N1:NOZZLE", "SK-1:ATTACHMENT"].sort(),
      );
      expect(dry).toMatchObject({ stepsToLink: 6, weldJointsToLink: 1, multiJointSteps: 2 });
      expect(await owner.plannedJoint.count({ where: { equipmentId: eq.id } })).toBe(0); // a dry run writes nothing

      await run(true);
      const joints = await owner.plannedJoint.findMany({ where: { equipmentId: eq.id } });
      expect(joints).toHaveLength(5);
      expect(joints.every((j) => j.source === "IMPORTED" && j.confirmed === false)).toBe(true);
      const steps = await stepsOf(r.jobId);
      expect(steps.filter((s) => s.plannedJointId != null)).toHaveLength(6); // LS, CS, SK on both units
      expect(steps.filter((s) => s.templateStep.activity === "Weld nozzles").every((s) => s.plannedJointId == null)).toBe(true);
      expect(steps.map((s) => s.seq).sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]); // seq untouched
      const welds = await owner.weldJoint.findMany({ where: { jobId: r.jobId }, orderBy: { id: "asc" } });
      expect(welds[0].plannedJointId).toBe(joints.find((j) => j.jointNo === "LS-1")!.id);
      expect(welds[1].plannedJointId).toBeNull(); // a number the steps never named is not guessed
      expect(await owner.auditLog.count({ where: { tenantId: w.tenantId, userAgent: "j4a test" } })).toBe(1);

      const again = await run(true);
      expect(again).toMatchObject({ jointsToCreate: [], stepsToLink: 0, weldJointsToLink: 0 });
    });
  });
});
