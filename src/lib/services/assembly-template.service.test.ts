import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeWorkbook } from "./master-import.test-util";

/**
 * Lean Core J4c — an equipment type's assembly sequence as master data: dry run, import as a
 * DRAFT version, publish by the Production Head with maker-checker. Refusals first.
 * Fixture: the 11 Oct workbook's "HP Air Receiver Blow Down Vessel" rows (read from docs/, never
 * seeded). DB-gated; every world is its own disposable tenant (owner client bypasses RLS).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const WORKBOOK = path.resolve(__dirname, "../../../docs/lean-core/inputs/2026-10-11-master-list/Standard_Parts_Master_PV_HE_SAMPLE.xlsx");
const LABEL = "HP Air Receiver Blow Down Vessel";
const HEADER = [
  "Example?", "Equipment Type", "Group Code", "Group Name", "Step No.", "Seq", "Activity", "Kind",
  "Parts / Sub-assemblies used", "Result\n(sub-assembly produced)", "Weld Joint Ref.", "Department", "Counts toward\nStage No.", "Remarks",
];
/** A small synthetic sheet: row = [group, step, seq, activity, kind, jointRef, department, stage]. */
const sheet = (rows: string[][], label = "Small Vessel") =>
  makeWorkbook({
    "Assembly Sequence": {
      header: HEADER,
      rows: rows.map(([g, step, seq, activity, kind, joint, dept, stage]) => ["", label, g, "Group", step, seq, activity, kind, "SHL-01", "", joint, dept, stage, ""]),
    },
  });
const FAB = "Fabrication / Welding";
const QC = "Quality Control / QA";
const SMALL = [
  ["G1", "1.1", "10", "Fit shell seam (LS-1)", "Work", "LS-1", FAB, "15"],
  ["G1", "1.1", "20", "Weld shell seam (LS-1)", "Work", "LS-1", FAB, "16"],
  ["G1", "1.1", "30", "Final inspection", "Inspection", "", QC, "25"],
];

describe.skipIf(!RUN_DB)("Lean Core J4c assembly sequence (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { ROLES } = await import("@/lib/authz");
  const { ERROR_CODES } = await import("@/lib/shared/errors");
  const { createJob } = await import("./job-intake.service");
  const { releaseJobBoms } = await import("./bom-release.test-util");
  const svc = await import("./assembly-template.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;
  afterAll(() => owner.$disconnect());

  const DEPTS = [FAB, QC, "Heat Treatment", "Surface Treatment & Painting", "Documentation / MDR"];

  async function world(label: string, opts: { question?: boolean } = {}) {
    const org = await owner.organization.create({ data: { code: `TEST-J4C-${label}-${stamp}-${++n}`, name: `j4c ${label}` } });
    const tenantId = org.id;
    const depts = await Promise.all(DEPTS.map((name, i) => owner.department.create({ data: { tenantId, code: `D${i}`, name } })));
    const mkUser = (who: string) => owner.user.create({ data: { tenantId, email: `${uniq(who)}@test.local`, username: uniq(who), passwordHash: "x", name: who, mustChangePassword: false } });
    const [admin, sj, sj2, eng, qc, sup] = await Promise.all(["Admin", "SJ", "SJ2", "Eng", "QC", "Sup"].map(mkUser));
    const actorOf = (u: { id: number; email: string }, roles: string[], clientId: number | null = null) => ({
      userId: u.id, tenantId, clientId, name: "x", email: u.email, roles: roles as never, departmentIds: [],
      mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false,
    });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    for (let i = 1; i <= 36; i++) {
      await owner.templateProcess.create({ data: { versionId: tv.id, seq: i, code: String(i), name: `Process ${i}`, defaultDepartmentId: depts[0].id } });
    }
    const type = await owner.equipmentTypeRef.create({ data: { tenantId, familyId: family.id, code: "PV-VERT-SKIRT", name: "Vertical vessel on skirt" } });
    if (opts.question !== false) {
      await owner.configQuestion.create({ data: { tenantId, familyId: family.id, key: "shell_courses", label: "Shell courses", type: "NUMBER" } });
    }
    // the family-level sequence a job of this type falls back to until the type has its own
    const famTpl = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "Family sequence" } });
    const famV = await owner.assemblyTemplateVersion.create({ data: { templateId: famTpl.id, version: 1, status: "PUBLISHED", publishedAt: new Date() } });
    await owner.assemblyTemplateStep.create({ data: { versionId: famV.id, seq: 1, groupCode: "A", groupName: "A", srNo: "1", activity: "Family step", kind: "WORK", defaultDepartmentId: depts[0].id } });
    // an approved pressure part, for the pressure flag
    const ct = await owner.componentTypeRef.create({ data: { tenantId, code: "SHL-01", name: "Shell course", kind: "PART_FAMILY" } });
    await owner.partFamily.create({ data: { tenantId, componentTypeId: ct.id, status: "APPROVED", pressureRetaining: true, approvedById: sj.id, approvedAt: new Date() } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const clientUser = await mkUser("ClientU");
    // J5a: createJob makes no assembly steps; the BOM release (an empty BOM here) does.
    const make = async (actor: ReturnType<typeof actorOf>, courses: number) => {
      const r = await createJob(actor, {
        clientId: client.id, familyId: family.id, templateVersionId: tv.id, calendarId: null, jobNumber: uniq("J4C"),
        clientOrderNo: null, projectName: null, poRef: null, designCode: null, orderDate: null, committedDeliveryDate: null,
        targetDispatchDate: null, priority: "NORMAL", remarks: null, excludedProcessCodes: [], exclusionReason: null,
        equipments: [{ equipmentTypeId: type.id, name: "Vessel", blockNo: 1, remarks: null, config: { shell_courses: courses }, serials: ["S1"] }],
        qcpTemplateSourceId: null, copyBomFromEquipmentId: null,
      } as never);
      await releaseJobBoms(owner, actor, r.jobId);
      return r;
    };
    return {
      tenantId, org, type, family, famV, make,
      admin: actorOf(admin, [ROLES.ADMIN]),
      sj: actorOf(sj, [ROLES.PRODUCTION_HEAD]),
      sj2: actorOf(sj2, [ROLES.PRODUCTION_HEAD]),
      eng: actorOf(eng, [ROLES.ENGINEERING]),
      qc: actorOf(qc, [ROLES.QC]),
      sup: actorOf(sup, [ROLES.SUPERVISOR]),
      client: actorOf(clientUser, [ROLES.CLIENT_VIEWER], client.id),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const counts = (w: World) =>
    Promise.all([
      owner.assemblyTemplate.count({ where: { tenantId: w.tenantId } }),
      owner.assemblyTemplateVersion.count({ where: { template: { tenantId: w.tenantId } } }),
      owner.assemblyTemplateStep.count({ where: { version: { template: { tenantId: w.tenantId } } } }),
      owner.auditLog.count({ where: { tenantId: w.tenantId } }),
    ]);
  const small = (extra: string[][] = []) => sheet([...SMALL, ...extra]);
  const importIt = async (w: World, actor: World["admin"], bytes: Buffer, label = "Small Vessel") => {
    const rep = await svc.dryRunAssemblySequence(actor, bytes, { equipmentTypeId: w.type.id, label });
    return svc.importAssemblySequence(actor, bytes, { equipmentTypeId: w.type.id, label, fileName: "t.xlsx", planFingerprint: rep.planFingerprint });
  };

  describe("refusals", () => {
    it.each([
      ["a supervisor", "sup"],
      ["QC", "qc"],
      ["a client user", "client"],
      ["Engineering", "eng"],
    ] as const)("%s can neither check nor import", async (_n, who) => {
      const w = await world("roles");
      const bytes = small();
      await expect(svc.dryRunAssemblySequence(w[who], bytes, { equipmentTypeId: w.type.id })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      await expect(
        svc.importAssemblySequence(w[who], bytes, { equipmentTypeId: w.type.id, label: "Small Vessel", fileName: "t.xlsx", planFingerprint: "x" }),
      ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      await expect(svc.loadAssemblyVersions(w[who], w.type.id)).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it("another tenant's equipment type is not found", async () => {
      const [a, b] = [await world("ta"), await world("tb")];
      await expect(svc.dryRunAssemblySequence(b.admin, small(), { equipmentTypeId: a.type.id })).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
      await expect(svc.loadAssemblyVersions(b.sj, a.type.id)).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    });

    it("a label the sheet does not have is refused", async () => {
      const w = await world("label");
      await expect(svc.dryRunAssemblySequence(w.admin, small(), { equipmentTypeId: w.type.id, label: "Nope" })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
    });

    it("a workbook without the sheet is refused with the reason", async () => {
      const w = await world("nosheet");
      const bytes = makeWorkbook({ "Parts Master": { header: ["Part Code"], rows: [] } });
      await expect(svc.dryRunAssemblySequence(w.admin, bytes, { equipmentTypeId: w.type.id })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
    });

    it("a sheet with an error cannot be imported, and nothing is written", async () => {
      const w = await world("err");
      const bytes = small([["G1", "1.2", "40", "Bad department", "Work", "", "Welding Shop", "16"]]);
      const rep = await svc.dryRunAssemblySequence(w.admin, bytes, { equipmentTypeId: w.type.id });
      expect(rep.errors).toBe(1);
      expect(rep.outcome).toBeNull();
      const before = await counts(w);
      await expect(
        svc.importAssemblySequence(w.admin, bytes, { equipmentTypeId: w.type.id, label: "Small Vessel", fileName: "t.xlsx", planFingerprint: rep.planFingerprint }),
      ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
      expect(await counts(w)).toEqual(before);
    });

    it("a changed file after the check is refused (the plan fingerprint)", async () => {
      const w = await world("fp");
      const rep = await svc.dryRunAssemblySequence(w.admin, small(), { equipmentTypeId: w.type.id });
      const other = small([["G1", "1.3", "40", "One more step", "Work", "", FAB, "16"]]);
      await expect(
        svc.importAssemblySequence(w.admin, other, { equipmentTypeId: w.type.id, label: "Small Vessel", fileName: "t.xlsx", planFingerprint: rep.planFingerprint }),
      ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
    });
  });

  describe("dry run and import", () => {
    it("the dry run writes nothing, and asks which workbook type when there are several", async () => {
      const w = await world("dry");
      const before = await counts(w);
      const bytes = makeWorkbook({
        "Assembly Sequence": {
          header: HEADER,
          rows: [
            ["", "Type A", "G", "G", "1", "10", "Step a", "Work", "", "", "", FAB, "16", ""],
            ["", "Type B", "G", "G", "1", "10", "Step b", "Work", "", "", "", FAB, "16", ""],
          ],
        },
      });
      const rep = await svc.dryRunAssemblySequence(w.admin, bytes, { equipmentTypeId: w.type.id });
      expect(rep).toMatchObject({ needsLabel: true, label: null, steps: [] });
      expect(rep.labels.map((l) => l.label)).toEqual(["Type A", "Type B"]);
      const one = await svc.dryRunAssemblySequence(w.admin, bytes, { equipmentTypeId: w.type.id, label: "Type B" });
      expect(one.steps.map((s) => s.activity)).toEqual(["Step b"]);
      expect(await counts(w)).toEqual(before);
    });

    it("imports as a DRAFT version on the type's own template, preparer recorded, audited", async () => {
      const w = await world("imp");
      const r = await importIt(w, w.admin, small());
      expect(r).toMatchObject({ outcome: "NEW_DRAFT", version: 1, steps: 3 });
      const v = await owner.assemblyTemplateVersion.findUniqueOrThrow({
        where: { id: r.versionId! },
        include: { template: true, steps: { orderBy: { seq: "asc" } } },
      });
      expect(v).toMatchObject({ status: "DRAFT", publishedAt: null, approvedById: null, preparedById: w.admin.userId });
      expect(v.template).toMatchObject({ equipmentTypeId: w.type.id, tenantId: w.tenantId, familyId: w.family.id });
      expect(v.steps.map((s) => [s.seq, s.scope, s.jointType, s.role, s.kind, s.requiresQc, s.qcpSrNo, s.jointRef])).toEqual([
        [1, "PER_JOINT", "LONG_SEAM", "FIT_UP", "WORK", true, null, null],
        [2, "PER_JOINT", "LONG_SEAM", "WELD", "WORK", true, null, null],
        [3, "PER_UNIT", null, null, "INSPECTION", true, null, null],
      ]);
      expect(v.steps[0].pressurePart).toBe(true); // LS is a pressure joint, and SHL-01 an approved pressure part
      const audit = await owner.auditLog.findMany({ where: { tenantId: w.tenantId, action: "assemblyTemplate.import" } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: w.admin.userId, entityId: String(v.id) });
    });

    it("importing the same sheet again changes nothing", async () => {
      const w = await world("again");
      const first = await importIt(w, w.admin, small());
      const before = await counts(w);
      const second = await importIt(w, w.admin, small());
      expect(second).toMatchObject({ outcome: "UNCHANGED_DRAFT", versionId: first.versionId });
      expect(await counts(w)).toEqual(before);
    });

    it("a changed sheet replaces the draft in place (same version number)", async () => {
      const w = await world("upd");
      const first = await importIt(w, w.admin, small());
      const second = await importIt(w, w.sj, small([["G1", "1.2", "40", "Extra step", "Work", "", FAB, "16"]]));
      expect(second).toMatchObject({ outcome: "UPDATE_DRAFT", versionId: first.versionId, version: 1, steps: 4 });
      const v = await owner.assemblyTemplateVersion.findUniqueOrThrow({ where: { id: first.versionId! }, include: { steps: true } });
      expect(v.steps).toHaveLength(4);
      expect(v.preparedById).toBe(w.sj.userId); // the last importer is the maker
      expect(await owner.assemblyTemplateVersion.count({ where: { template: { tenantId: w.tenantId } } })).toBe(2); // family v1 + this draft
    });
  });

  describe("publish (maker-checker)", () => {
    it.each([
      ["admin", "admin"],
      ["QC", "qc"],
      ["Engineering", "eng"],
      ["a client user", "client"],
    ] as const)("%s cannot publish", async (_n, who) => {
      const w = await world("pubrole");
      const r = await importIt(w, w.admin, small());
      await expect(svc.publishAssemblyTemplateVersion(w[who], { versionId: r.versionId! })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it("the person who imported it cannot publish it, even a Production Head", async () => {
      const w = await world("mc");
      const r = await importIt(w, w.sj, small());
      await expect(svc.publishAssemblyTemplateVersion(w.sj, { versionId: r.versionId! })).rejects.toMatchObject({ code: ERROR_CODES.MAKER_CHECKER_VIOLATION });
      expect((await owner.assemblyTemplateVersion.findUniqueOrThrow({ where: { id: r.versionId! } })).status).toBe("DRAFT");
    });

    it("another tenant's version is not found", async () => {
      const [a, b] = [await world("pa"), await world("pb")];
      const r = await importIt(a, a.admin, small());
      await expect(svc.publishAssemblyTemplateVersion(b.sj, { versionId: r.versionId! })).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    });

    it("refuses a sequence with shell-driven welds when the type has no shell courses question", async () => {
      const w = await world("noq", { question: false });
      const rep = await svc.dryRunAssemblySequence(w.admin, small(), { equipmentTypeId: w.type.id });
      expect(rep.issues.some((i) => i.code === "NO_SHELL_COURSES_QUESTION")).toBe(true);
      const r = await importIt(w, w.admin, small()); // importing is allowed, publishing is not
      await expect(svc.publishAssemblyTemplateVersion(w.sj, { versionId: r.versionId! })).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_INCOMPLETE });
    });

    it("publishes: server time, approver recorded, audited; a second publish is refused", async () => {
      const w = await world("pub");
      const r = await importIt(w, w.admin, small());
      const out = await svc.publishAssemblyTemplateVersion(w.sj, { versionId: r.versionId! });
      const v = await owner.assemblyTemplateVersion.findUniqueOrThrow({ where: { id: r.versionId! } });
      expect(v).toMatchObject({ status: "PUBLISHED", approvedById: w.sj.userId, preparedById: w.admin.userId });
      expect(v.publishedAt!.getTime()).toBe(out.publishedAt.getTime());
      expect(Math.abs(Date.now() - v.publishedAt!.getTime())).toBeLessThan(60_000);
      expect(await owner.auditLog.count({ where: { tenantId: w.tenantId, action: "assemblyTemplate.publish", entityId: String(v.id) } })).toBe(1);
      await expect(svc.publishAssemblyTemplateVersion(w.sj2, { versionId: v.id })).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_VERSION_LOCKED });
    });
  });

  describe("after publishing", () => {
    it("a published version is never edited: a changed import is a new DRAFT, the published steps stay", async () => {
      const w = await world("immut");
      const r1 = await importIt(w, w.admin, small());
      await svc.publishAssemblyTemplateVersion(w.sj, { versionId: r1.versionId! });
      expect(await importIt(w, w.admin, small())).toMatchObject({ outcome: "UNCHANGED_PUBLISHED", version: 1 });
      const r2 = await importIt(w, w.admin, small([["G1", "1.2", "40", "Extra step", "Work", "", FAB, "16"]]));
      expect(r2).toMatchObject({ outcome: "NEW_DRAFT", version: 2 });
      expect(await owner.assemblyTemplateStep.count({ where: { versionId: r1.versionId! } })).toBe(3);
      expect((await owner.assemblyTemplateVersion.findUniqueOrThrow({ where: { id: r1.versionId! } })).status).toBe("PUBLISHED");
    });

    it("a job created afterwards gets the new version, with a step per seam; a job created before keeps its own", async () => {
      const w = await world("job");
      const before = await w.make(w.admin, 2); // no sequence of its own yet: the family template
      const r = await importIt(w, w.admin, small());
      await svc.publishAssemblyTemplateVersion(w.sj, { versionId: r.versionId! });
      const after = await w.make(w.admin, 2);

      const eqBefore = await owner.equipment.findFirstOrThrow({ where: { jobId: before.jobId } });
      const eqAfter = await owner.equipment.findFirstOrThrow({ where: { jobId: after.jobId } });
      expect(eqBefore.assemblyTemplateVersionId).toBe(w.famV.id);
      expect(eqAfter.assemblyTemplateVersionId).toBe(r.versionId);

      const stepsOf = (jobId: number) => owner.assemblyStep.findMany({ where: { jobId }, orderBy: { seq: "asc" }, include: { templateStep: true } });
      expect(await stepsOf(before.jobId)).toHaveLength(1); // the family step, untouched
      const rows = await stepsOf(after.jobId);
      // 2 shell courses: LS-1, LS-2 (fit + weld each) and the per-unit inspection
      expect(rows.map((s) => [s.templateStep.activity, s.jointRef])).toEqual([
        ["Fit shell seam", "LS-1"], ["Fit shell seam", "LS-2"],
        ["Weld shell seam", "LS-1"], ["Weld shell seam", "LS-2"],
        ["Final inspection", null],
      ]);
      expect(rows.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(rows[0]).toMatchObject({ role: "FIT_UP", pressurePart: true });
    });
  });

  describe.skipIf(!existsSync(WORKBOOK))("the 11 Oct workbook, 'HP Air Receiver Blow Down Vessel' (explicit fixture)", () => {
    it("checks with 31 steps and imports as a draft; the other types in the file are not read", async () => {
      const w = await world("wb");
      const bytes = readFileSync(WORKBOOK);
      const rep = await svc.dryRunAssemblySequence(w.admin, bytes, { equipmentTypeId: w.type.id });
      expect(rep.needsLabel).toBe(true);
      expect(rep.labels.map((l) => l.rows)).toEqual(expect.arrayContaining([31, 20, 6]));
      const full = await svc.dryRunAssemblySequence(w.admin, bytes, { equipmentTypeId: w.type.id, label: LABEL });
      expect(full.errors).toBe(0);
      expect(full.steps).toHaveLength(31);
      expect(full.outcome).toBe("NEW_DRAFT");
      const r = await svc.importAssemblySequence(w.admin, bytes, { equipmentTypeId: w.type.id, label: LABEL, fileName: "m.xlsx", planFingerprint: full.planFingerprint });
      expect(r).toMatchObject({ outcome: "NEW_DRAFT", version: 1, steps: 31 });
      const views = await svc.loadAssemblyVersions(w.sj, w.type.id);
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({ status: "DRAFT", preparedByName: "Admin", approvedByName: null, pinnedLines: 0 });
      expect(views[0].steps.filter((s) => s.scope === "PER_JOINT")).toHaveLength(11); // 7 seam + 2 nozzle + 2 attachment
      await svc.publishAssemblyTemplateVersion(w.sj, { versionId: r.versionId! });
      // a job of the type now plans its seams from the answer: 3 courses -> LS-1..3 and CS-1..4
      const job = await w.make(w.admin, 3);
      const steps = await owner.assemblyStep.findMany({ where: { jobId: job.jobId }, include: { templateStep: true } });
      const per = (t: string) => steps.filter((s) => s.templateStep.jointType === t).length;
      expect(per("LONG_SEAM")).toBe(3 * 3); // fit, weld, NDT on each of 3 long seams
      expect(per("CIRC_SEAM")).toBe(4 * 4); // fit, weld, fit-and-weld, NDT on each of 4 circ seams
      expect(per("NOZZLE")).toBe(0); // no nozzle joints on the weld map yet (J4b): the steps expand to nothing
    });
  });
});
