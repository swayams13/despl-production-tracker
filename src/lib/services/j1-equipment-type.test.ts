import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Lean Core J1 — equipment type is the assembly-template anchor.
 * Proves migration 20261019160000_j1_equipment_type_anchor (CHECKs, uniques,
 * RLS), the template resolver, the idempotent setup, and the acceptance rule:
 * a job created from the "vertical on skirt" type gets exactly the steps an
 * untyped job gets today. Violation cases first, per CLAUDE.md.
 *
 * `owner` (DIRECT_URL, bypasses RLS) builds fixtures; `withTenant` (despl_web)
 * makes the isolation assertions. Gated behind RUN_DB_TESTS.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core J1 equipment type anchor (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { resolveAssemblyTemplateVersion } = await import("./assembly-template.resolve");
  const { ensurePvEquipmentTypes, SKIRT_TYPE_CODE } = await import("./equipment-type.setup");
  const { createJob } = await import("./job-intake.service");
  const { ROLES } = await import("@/lib/authz");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  async function fixture(suffix: string) {
    const org = await owner.organization.create({ data: { code: `TEST-J1-${suffix}-${stamp}`, name: `j1 ${suffix}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const plate = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const type = (code: string) =>
      owner.equipmentTypeRef.create({ data: { tenantId, familyId: family.id, code, name: code } });
    /** A template (family-level when typeId is null) with one version holding two steps. */
    const template = async (typeId: number | null, status: "PUBLISHED" | "DRAFT", label: string) => {
      const t = await owner.assemblyTemplate.create({
        data: { tenantId, familyId: family.id, name: label, equipmentTypeId: typeId },
      });
      const v = await owner.assemblyTemplateVersion.create({
        data: { templateId: t.id, version: 1, status, publishedAt: status === "PUBLISHED" ? new Date() : null },
      });
      await owner.assemblyTemplateStep.createMany({
        data: [1, 2].map((seq) => ({
          versionId: v.id,
          seq,
          groupCode: "A",
          groupName: "Group A",
          srNo: `${seq}`,
          activity: `${label} step ${seq}`,
          kind: "WORK" as const,
          defaultDepartmentId: dept.id,
        })),
      });
      return { template: t, version: v };
    };
    return { tenantId, dept, family, plate, type, template };
  }

  let a: Awaited<ReturnType<typeof fixture>>;
  let b: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    a = await fixture("A");
    b = await fixture("B");
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  describe("schema constraints", () => {
    it.each([
      ["lower case", "fixed"],
      ["empty", ""],
      ["bare ANSWER", "ANSWER:"],
      ["ANSWER with upper case", "ANSWER:Shell"],
      ["ANSWER with a space", "ANSWER:a b"],
      ["unknown source", "MANUAL"],
    ])("rejects qty_source %s", async (_label, qtySource) => {
      const t = await a.type(`CHK-${Math.random().toString(36).slice(2, 7)}`);
      await expect(
        owner.equipmentTypeComponent.create({
          data: { tenantId: a.tenantId, equipmentTypeId: t.id, componentTypeId: a.plate.id, qtySource },
        }),
      ).rejects.toThrow(/equipment_type_components_qty_source_chk|check constraint/i);
    });

    it("rejects a negative default quantity", async () => {
      const t = await a.type(`NEG-${Math.random().toString(36).slice(2, 7)}`);
      await expect(
        owner.equipmentTypeComponent.create({
          data: { tenantId: a.tenantId, equipmentTypeId: t.id, componentTypeId: a.plate.id, defaultQty: -1 },
        }),
      ).rejects.toThrow(/equipment_type_components_qty_chk|check constraint/i);
    });

    it("accepts FIXED, NOZZLE_SCHEDULE and ANSWER:<key>, but not the same component twice on a type", async () => {
      const t = await a.type(`OK-${Math.random().toString(36).slice(2, 7)}`);
      const second = await owner.componentTypeRef.create({ data: { tenantId: a.tenantId, code: `P2-${stamp}`, name: "P2" } });
      const third = await owner.componentTypeRef.create({ data: { tenantId: a.tenantId, code: `P3-${stamp}`, name: "P3" } });
      for (const [ct, qtySource] of [[a.plate, "FIXED"], [second, "NOZZLE_SCHEDULE"], [third, "ANSWER:shell_courses"]] as const) {
        await owner.equipmentTypeComponent.create({
          data: { tenantId: a.tenantId, equipmentTypeId: t.id, componentTypeId: ct.id, qtySource },
        });
      }
      await expect(
        owner.equipmentTypeComponent.create({
          data: { tenantId: a.tenantId, equipmentTypeId: t.id, componentTypeId: a.plate.id },
        }),
      ).rejects.toThrow(/Unique constraint/i);
    });

    it("allows one assembly template per equipment type, not two", async () => {
      const t = await a.type(`ONE-${Math.random().toString(36).slice(2, 7)}`);
      await a.template(t.id, "PUBLISHED", "first");
      await expect(a.template(t.id, "PUBLISHED", "second")).rejects.toThrow(/Unique constraint/i);
    });

    it("keeps many family-level templates possible (NULL equipment type is not unique)", async () => {
      const f = await fixture("NULLS");
      await f.template(null, "PUBLISHED", "one");
      await expect(f.template(null, "PUBLISHED", "two")).resolves.toBeDefined();
    });
  });

  describe("tenant isolation (app role)", () => {
    it("tenant B cannot read tenant A's equipment type kit, and cannot write into it", async () => {
      const t = await a.type(`RLS-${Math.random().toString(36).slice(2, 7)}`);
      const row = await owner.equipmentTypeComponent.create({
        data: { tenantId: a.tenantId, equipmentTypeId: t.id, componentTypeId: a.plate.id },
      });
      const seenByB = await withTenant(b.tenantId, (tx) => tx.equipmentTypeComponent.findMany({ where: { id: row.id } }));
      expect(seenByB).toEqual([]);
      const seenByA = await withTenant(a.tenantId, (tx) => tx.equipmentTypeComponent.findMany({ where: { id: row.id } }));
      expect(seenByA).toHaveLength(1);
      await expect(
        withTenant(b.tenantId, (tx) =>
          tx.equipmentTypeComponent.create({
            data: { tenantId: a.tenantId, equipmentTypeId: t.id, componentTypeId: a.plate.id },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("resolveAssemblyTemplateVersion", () => {
    it("picks the type's template, else the family-level one, and never lets an untyped line read a type template", async () => {
      const f = await fixture("RESOLVE");
      const family = await f.template(null, "PUBLISHED", "family");
      const withOwn = await f.type("OWN");
      const own = await f.template(withOwn.id, "PUBLISHED", "own");
      const noTemplate = await f.type("NONE");
      const draftOnly = await f.type("DRAFT");
      await f.template(draftOnly.id, "DRAFT", "draft");

      const resolve = (typeId: number | null) =>
        withTenant(f.tenantId, (tx) => resolveAssemblyTemplateVersion(tx, f.tenantId, f.family.id, typeId)).then((v) => v?.id ?? null);

      expect(await resolve(withOwn.id)).toBe(own.version.id);
      expect(await resolve(noTemplate.id)).toBe(family.version.id);
      expect(await resolve(draftOnly.id)).toBe(family.version.id);
      expect(await resolve(null)).toBe(family.version.id);
    });

    it("returns nothing for an untyped line when the family has only type-anchored templates", async () => {
      const f = await fixture("ONLYTYPED");
      const t = await f.type("T");
      await f.template(t.id, "PUBLISHED", "typed");
      const got = await withTenant(f.tenantId, (tx) => resolveAssemblyTemplateVersion(tx, f.tenantId, f.family.id, null));
      expect(got).toBeNull();
    });

    it("does not read another tenant's template", async () => {
      const f = await fixture("XTENANT");
      await f.template(null, "PUBLISHED", "family");
      const got = await withTenant(b.tenantId, (tx) => resolveAssemblyTemplateVersion(tx, f.tenantId, f.family.id, null));
      expect(got).toBeNull();
    });
  });

  describe("ensurePvEquipmentTypes", () => {
    it("dry run writes nothing; apply creates the types, a skirt template copy and the kit; a second apply creates nothing", async () => {
      const f = await fixture("ENSURE");
      const family = await f.template(null, "PUBLISHED", "family");
      for (const code of ["DISHED_END", "SKIRT", "FORGING", "FLANGE", "PIPE", "COUPLING"]) {
        await owner.componentTypeRef.create({ data: { tenantId: f.tenantId, code, name: code } });
      }

      const dry = await ensurePvEquipmentTypes(owner, f.tenantId, { apply: false });
      expect(dry.typesCreated).toHaveLength(3);
      expect(await owner.equipmentTypeRef.count({ where: { tenantId: f.tenantId } })).toBe(0);
      expect(await owner.assemblyTemplate.count({ where: { tenantId: f.tenantId } })).toBe(1);

      const first = await ensurePvEquipmentTypes(owner, f.tenantId, { apply: true, audit: true, auditSource: "j1 test" });
      expect(first.typesCreated).toHaveLength(3);
      expect(first.skipped).toEqual([]);
      const types = await owner.equipmentTypeRef.findMany({ where: { tenantId: f.tenantId }, orderBy: { code: "asc" } });
      expect(types.map((t) => [t.code, t.active])).toEqual([
        ["PV-HORZ-SADDLE", false],
        ["PV-VERT-LEGS", false],
        ["PV-VERT-SKIRT", true],
      ]);
      const skirt = types.find((t) => t.code === SKIRT_TYPE_CODE)!;
      const copy = await owner.assemblyTemplate.findFirstOrThrow({
        where: { equipmentTypeId: skirt.id },
        include: { versions: { include: { steps: { orderBy: { seq: "asc" } } } } },
      });
      const source = await owner.assemblyTemplateVersion.findUniqueOrThrow({
        where: { id: family.version.id },
        include: { steps: { orderBy: { seq: "asc" } } },
      });
      const content = ({ id: _i, versionId: _v, ...rest }: (typeof source.steps)[number]) => rest;
      expect(copy.versions).toHaveLength(1);
      expect(copy.versions[0].status).toBe("PUBLISHED");
      expect(copy.versions[0].steps.map(content)).toEqual(source.steps.map(content));
      // legs and saddles get no template of their own until D18 and J4
      expect(await owner.assemblyTemplate.count({ where: { equipmentTypeId: { in: types.filter((t) => t.id !== skirt.id).map((t) => t.id) } } })).toBe(0);
      const kit = await owner.equipmentTypeComponent.findMany({ where: { equipmentTypeId: skirt.id }, include: { componentType: true } });
      expect(kit.map((k) => [k.componentType.code, k.defaultQty, k.qtySource]).sort()).toEqual(
        [["COUPLING", 3, "FIXED"], ["DISHED_END", 2, "FIXED"], ["FLANGE", 1, "FIXED"], ["FORGING", 2, "FIXED"], ["PIPE", 1, "FIXED"], ["PLATE", 1, "FIXED"], ["SKIRT", 1, "FIXED"]].sort(),
      );
      expect(await owner.auditLog.count({ where: { tenantId: f.tenantId, userAgent: "j1 test" } })).toBe(3 + 1 + 7);

      const second = await ensurePvEquipmentTypes(owner, f.tenantId, { apply: true, audit: true, auditSource: "j1 test" });
      expect(second.typesCreated).toEqual([]);
      expect(second.templateCreated).toBeNull();
      expect(second.kitCreated).toEqual([]);
      expect(await owner.assemblyTemplate.count({ where: { tenantId: f.tenantId } })).toBe(2);
    });

    it("reports, instead of failing, when the family has no template to copy", async () => {
      const f = await fixture("NOTEMPLATE");
      const r = await ensurePvEquipmentTypes(owner, f.tenantId, { apply: true });
      expect(r.templateCreated).toBeNull();
      expect(r.skipped.join(" ")).toMatch(/no published family assembly template/);
    });
  });

  describe("createJob from an equipment type (seeded tenant 1)", () => {
    const actor = {
      userId: 1,
      tenantId: 1,
      clientId: null,
      name: "Admin",
      email: "admin@despl.test",
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM" as const,
      outdoorMode: false,
    };
    const createdJobs: number[] = [];

    async function refs() {
      const version = await owner.processTemplateVersion.findFirstOrThrow({
        where: { status: "PUBLISHED", template: { tenantId: 1, family: { code: "PRESSURE_VESSEL" } } },
        orderBy: { version: "desc" },
        include: { template: true },
      });
      const client = await owner.client.findFirstOrThrow({ where: { tenantId: 1 } });
      const qcp = await owner.qcpTemplate.findFirstOrThrow({ where: { job: { jobNumber: "DESPL-320" } } });
      await ensurePvEquipmentTypes(owner, 1, { apply: true });
      const skirt = await owner.equipmentTypeRef.findFirstOrThrow({ where: { tenantId: 1, code: SKIRT_TYPE_CODE } });
      return { version, client, qcp, skirt, familyId: version.template.familyId };
    }
    type Refs = Awaited<ReturnType<typeof refs>>;

    function make(r: Refs, jobNumber: string, blocks: { typeId: number | null; serials: string[] }[]) {
      return createJob(actor, {
        clientId: r.client.id,
        familyId: r.familyId,
        templateVersionId: r.version.id,
        calendarId: null,
        jobNumber,
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
        equipments: blocks.map((bl, i) => ({
          equipmentTypeId: bl.typeId,
          name: `Vessel ${i + 1}`,
          blockNo: i + 1,
          remarks: null,
          serials: bl.serials,
        })),
        qcpTemplateSourceId: r.qcp.id,
        copyBomFromEquipmentId: null,
      } as never).then((res) => {
        createdJobs.push(res.jobId);
        return res;
      });
    }

    /** Per-unit step content, with the QCP binding reduced to the bound item's position in its own template. */
    async function stepRows(jobId: number, serial?: string) {
      const steps = await owner.assemblyStep.findMany({
        where: { jobId, ...(serial ? { unit: { serialNo: serial } } : {}) },
        orderBy: [{ unit: { serialNo: "asc" } }, { seq: "asc" }],
        include: { templateStep: true, qcpItem: true, unit: true },
      });
      return steps.map((s) => ({
        serial: s.unit.serialNo,
        seq: s.seq,
        group: s.templateStep.groupCode,
        groupName: s.templateStep.groupName,
        srNo: s.templateStep.srNo,
        activity: s.templateStep.activity,
        kind: s.templateStep.kind,
        departmentId: s.templateStep.defaultDepartmentId,
        qcpSrNo: s.templateStep.qcpSrNo,
        leadTimeProcessSeq: s.templateStep.leadTimeProcessSeq,
        jointRef: s.jointRef,
        role: s.role,
        pressurePart: s.pressurePart,
        requiresQc: s.requiresQc,
        qcpBound: s.qcpItem ? { srNo: s.qcpItem.srNo, sequence: s.qcpItem.sequence } : null,
      }));
    }

    afterAll(async () => {
      for (const id of createdJobs) {
        await owner.component.deleteMany({ where: { equipment: { jobId: id } } }).catch(() => {});
        await owner.assemblyStep.deleteMany({ where: { jobId: id } }).catch(() => {});
        await owner.processPlan.deleteMany({ where: { scheduleRun: { jobId: id } } }).catch(() => {});
        await owner.scheduleRun.deleteMany({ where: { jobId: id } }).catch(() => {});
        await owner.unit.deleteMany({ where: { equipment: { jobId: id } } }).catch(() => {});
        await owner.equipment.deleteMany({ where: { jobId: id } }).catch(() => {});
        await owner.qcpTemplate.deleteMany({ where: { jobId: id } }).catch(() => {});
        await owner.job.delete({ where: { id } }).catch(() => {});
      }
    });

    it("refuses an equipment type that does not exist", async () => {
      const r = await refs();
      await expect(make(r, `J1-NOTYPE-${stamp}`, [{ typeId: 2_000_000_000, serials: ["X1"] }])).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("a job from the skirt type gets exactly the steps an untyped job gets, pinned to the type's own template version", async () => {
      const r = await refs();
      const untyped = await make(r, `J1-UNTYPED-${stamp}`, [{ typeId: null, serials: ["U1", "U2"] }]);
      const typed = await make(r, `J1-SKIRT-${stamp}`, [{ typeId: r.skirt.id, serials: ["U1", "U2"] }]);

      expect(typed.assemblyStepCount).toBe(untyped.assemblyStepCount);
      expect(typed.assemblyStepCount).toBeGreaterThan(0);
      expect(await stepRows(typed.jobId)).toEqual(await stepRows(untyped.jobId));

      const familyVersion = await resolveFamily(r);
      const skirtTemplate = await owner.assemblyTemplate.findFirstOrThrow({ where: { equipmentTypeId: r.skirt.id }, include: { versions: true } });
      const typedJob = await owner.job.findUniqueOrThrow({ where: { id: typed.jobId } });
      const untypedJob = await owner.job.findUniqueOrThrow({ where: { id: untyped.jobId } });
      expect(typedJob.assemblyTemplateVersionId).toBe(skirtTemplate.versions[0].id);
      expect(untypedJob.assemblyTemplateVersionId).toBe(familyVersion.id);
      expect(typedJob.assemblyTemplateVersionId).not.toBe(untypedJob.assemblyTemplateVersionId);
    });

    it("regenerates DESPL-320's steps from its equipment type (same content, same QCP binding)", async () => {
      const r = await refs();
      const regen = await make(r, `J1-REGEN-${stamp}`, [{ typeId: r.skirt.id, serials: ["320SR01"] }]);
      const despl = await owner.assemblyStep.findMany({
        where: { job: { jobNumber: "DESPL-320" }, unit: { serialNo: "320SR01" } },
        orderBy: { seq: "asc" },
        include: { templateStep: true, qcpItem: true },
      });
      const fresh = await owner.assemblyStep.findMany({
        where: { jobId: regen.jobId },
        orderBy: { seq: "asc" },
        include: { templateStep: true, qcpItem: true },
      });
      expect(fresh.length).toBe(despl.length);
      // Left out, both older than J1: requiresQc (createJob derives it by the D3 rule, the 18 Oct seed copied the
      // template value) and the QCP binding of WORK steps (the seed script fuzzy-binds them all, createJob binds
      // INSPECTION steps only, see materializeAssemblyStepsFromTemplate).
      const view = (s: (typeof fresh)[number]) => ({
        seq: s.seq,
        group: s.templateStep.groupCode,
        srNo: s.templateStep.srNo,
        activity: s.templateStep.activity,
        kind: s.templateStep.kind,
        qcpSrNo: s.templateStep.qcpSrNo,
        leadTimeProcessSeq: s.templateStep.leadTimeProcessSeq,
        jointRef: s.jointRef,
        role: s.role,
        pressurePart: s.pressurePart,
        qcpBound:
          s.templateStep.kind === "INSPECTION" && s.qcpItem ? { srNo: s.qcpItem.srNo, sequence: s.qcpItem.sequence } : null,
      });
      expect(fresh.map(view)).toEqual(despl.map(view));
    });

    it("gives each equipment block its own type's template; the first block's version is the job pin", async () => {
      const r = await refs();
      const familyVersion = await resolveFamily(r);
      const skirtVersion = (await owner.assemblyTemplate.findFirstOrThrow({ where: { equipmentTypeId: r.skirt.id }, include: { versions: true } })).versions[0];

      const skirtFirst = await make(r, `J1-MIX1-${stamp}`, [
        { typeId: r.skirt.id, serials: ["M1", "M2"] },
        { typeId: null, serials: ["M3"] },
      ]);
      const familyFirst = await make(r, `J1-MIX2-${stamp}`, [
        { typeId: null, serials: ["N1"] },
        { typeId: r.skirt.id, serials: ["N2", "N3"] },
      ]);
      const per = (jobId: number) =>
        owner.assemblyStep.groupBy({ by: ["unitId"], where: { jobId }, _count: true }).then((g) => g.map((x) => x._count));
      expect(await per(skirtFirst.jobId)).toEqual([54, 54, 54]);
      expect(await per(familyFirst.jobId)).toEqual([54, 54, 54]);
      expect((await owner.job.findUniqueOrThrow({ where: { id: skirtFirst.jobId } })).assemblyTemplateVersionId).toBe(skirtVersion.id);
      expect((await owner.job.findUniqueOrThrow({ where: { id: familyFirst.jobId } })).assemblyTemplateVersionId).toBe(familyVersion.id);
      // each unit's steps point at its own block's template version
      const byBlock = await owner.assemblyStep.findMany({
        where: { jobId: skirtFirst.jobId, seq: 1 },
        select: { unit: { select: { serialNo: true } }, templateStep: { select: { versionId: true } } },
      });
      const versionOf = (serial: string) => byBlock.find((s) => s.unit.serialNo === serial)!.templateStep.versionId;
      expect([versionOf("M1"), versionOf("M2"), versionOf("M3")]).toEqual([skirtVersion.id, skirtVersion.id, familyVersion.id]);
    });

    async function resolveFamily(r: Refs) {
      return owner.assemblyTemplateVersion.findFirstOrThrow({
        where: { template: { tenantId: 1, familyId: r.familyId, equipmentTypeId: null }, status: "PUBLISHED" },
        orderBy: { version: "desc" },
      });
    }
  });
});
