import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Lean Core M1 (PR A) — proves migration 20261013100000_m1_master_data_schema:
 * every new column takes the value that preserves today's behaviour, the
 * part-family / route-step / variant / material CHECKs and uniques hold, and
 * the three new tenant-root tables are tenant-isolated for the app role.
 *
 * Violation cases first, per CLAUDE.md. Same disposable-org pattern as
 * l11-lean-additive.test.ts: `owner` (DIRECT_URL, bypasses RLS) builds
 * fixtures across two tenants; `withTenant` (despl_web, RLS-subject) makes the
 * isolation assertions. Gated behind RUN_DB_TESTS.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org codes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core M1 master-data schema (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let counter = 0;
  async function fixture(suffix: string) {
    const stamp = `${Date.now()}-${Math.random()}`;
    const org = await owner.organization.create({ data: { code: `TEST-M1-${suffix}-${stamp}`, name: `m1 ${suffix}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const rawForm = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const operation = await owner.operationRef.create({ data: { tenantId, code: "CUTTING", name: "Cutting" } });
    const preparer = await owner.user.create({
      data: { tenantId, email: `m1-prep-${suffix}-${stamp}@test.local`, username: `m1-prep-${suffix}-${stamp}`, passwordHash: "x", name: "Preparer" },
    });
    const approver = await owner.user.create({
      data: { tenantId, email: `m1-appr-${suffix}-${stamp}@test.local`, username: `m1-appr-${suffix}-${stamp}`, passwordHash: "x", name: "Approver" },
    });
    const route = await owner.routeTemplate.create({
      data: { tenantId, componentTypeId: rawForm.id, familyId: family.id, name: "Plate route" },
    });
    const routeVersion = await owner.routeTemplateVersion.create({ data: { routeId: route.id, version: 1 } });
    const step = await owner.routeStep.create({ data: { routeVersionId: routeVersion.id, seq: 10, operationId: operation.id } });
    return { tenantId, dept, family, rawForm, operation, preparer, approver, route, routeVersion, step };
  }

  async function newPartFamilyType(f: Awaited<ReturnType<typeof fixture>>) {
    counter += 1;
    return owner.componentTypeRef.create({
      data: { tenantId: f.tenantId, code: `SHL-${counter}-${Math.random().toString(36).slice(2, 7)}`, name: "Shell Course", kind: "PART_FAMILY" },
    });
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

  describe("part-family approval CHECKs", () => {
    it("allows an approver who is also the preparer (one Production Head; flagged by the service, not forbidden by the DB)", async () => {
      const t = await newPartFamilyType(a);
      const row = await owner.partFamily.create({
        data: {
          tenantId: a.tenantId,
          componentTypeId: t.id,
          preparedById: a.preparer.id,
          approvedById: a.preparer.id,
          approvedAt: new Date(),
          status: "APPROVED",
        },
      });
      expect(row.approvedById).toBe(row.preparedById);
    });

    it("rejects APPROVED with no approver or no approval date", async () => {
      const t1 = await newPartFamilyType(a);
      await expect(
        owner.partFamily.create({ data: { tenantId: a.tenantId, componentTypeId: t1.id, status: "APPROVED" } }),
      ).rejects.toThrow(/part_families_approved_needs_approver_chk|check constraint/i);
      const t2 = await newPartFamilyType(a);
      await expect(
        owner.partFamily.create({
          data: { tenantId: a.tenantId, componentTypeId: t2.id, status: "APPROVED", approvedById: a.approver.id },
        }),
      ).rejects.toThrow(/check constraint/i);
      const t3 = await newPartFamilyType(a);
      await expect(
        owner.partFamily.create({
          data: { tenantId: a.tenantId, componentTypeId: t3.id, status: "APPROVED", approvedAt: new Date() },
        }),
      ).rejects.toThrow(/check constraint/i);
    });

    it("allows APPROVED by a different user, and a DRAFT with no preparer (imported row)", async () => {
      const t1 = await newPartFamilyType(a);
      const ok = await owner.partFamily.create({
        data: {
          tenantId: a.tenantId,
          componentTypeId: t1.id,
          preparedById: a.preparer.id,
          approvedById: a.approver.id,
          approvedAt: new Date(),
          status: "APPROVED",
        },
      });
      expect(ok.status).toBe("APPROVED");
      const t2 = await newPartFamilyType(a);
      const draft = await owner.partFamily.create({ data: { tenantId: a.tenantId, componentTypeId: t2.id } });
      expect(draft.status).toBe("DRAFT");
      expect(draft.equipmentScope).toBe("BOTH");
      expect(draft.isSpare).toBe(false);
    });

    it("allows only one part_families row per component type", async () => {
      const t = await newPartFamilyType(a);
      await owner.partFamily.create({ data: { tenantId: a.tenantId, componentTypeId: t.id } });
      await expect(owner.partFamily.create({ data: { tenantId: a.tenantId, componentTypeId: t.id } })).rejects.toThrow(
        /Unique constraint/i,
      );
    });

    it("refuses to delete a user who is recorded as an approver (RESTRICT)", async () => {
      const t = await newPartFamilyType(a);
      const approver = await owner.user.create({
        data: {
          tenantId: a.tenantId,
          email: `m1-del-${Math.random()}@test.local`,
          username: `m1-del-${Math.random()}`,
          passwordHash: "x",
          name: "Soon gone",
        },
      });
      await owner.partFamily.create({
        data: { tenantId: a.tenantId, componentTypeId: t.id, status: "APPROVED", approvedById: approver.id, approvedAt: new Date() },
      });
      await expect(owner.user.delete({ where: { id: approver.id } })).rejects.toThrow();
    });
  });

  describe("route variants", () => {
    it("rejects a second route with the same (tenant, type, family, variant)", async () => {
      await expect(
        owner.routeTemplate.create({
          data: { tenantId: a.tenantId, componentTypeId: a.rawForm.id, familyId: a.family.id, name: "dup" },
        }),
      ).rejects.toThrow(/Unique constraint/i);
    });

    it("allows variant B of the same (tenant, type, family)", async () => {
      const b2 = await owner.routeTemplate.create({
        data: { tenantId: a.tenantId, componentTypeId: a.rawForm.id, familyId: a.family.id, name: "variant B", variant: "B" },
      });
      expect(b2.variant).toBe("B");
    });

    it("rejects anything but a single capital letter as a variant", async () => {
      for (const bad of ["a", "AB", "1", ""]) {
        await expect(
          owner.routeTemplate.create({
            data: { tenantId: a.tenantId, componentTypeId: a.rawForm.id, familyId: a.family.id, name: `bad ${bad}`, variant: bad },
          }),
        ).rejects.toThrow(/route_templates_variant_chk|check constraint/i);
      }
    });

    it("existing routes read back as variant A", async () => {
      const r = await owner.routeTemplate.findUniqueOrThrow({ where: { id: a.route.id } });
      expect(r.variant).toBe("A");
    });
  });

  describe("route-step standard time", () => {
    it("rejects a standard time with no unit or no basis, and a negative time", async () => {
      await expect(
        owner.routeStep.update({ where: { id: a.step.id }, data: { stdTime: "0.5" } }),
      ).rejects.toThrow(/route_steps_std_time_chk|check constraint/i);
      await expect(
        owner.routeStep.update({ where: { id: a.step.id }, data: { stdTime: "0.5", stdTimeUnit: "HOURS" } }),
      ).rejects.toThrow(/check constraint/i);
      await expect(
        owner.routeStep.update({
          where: { id: a.step.id },
          data: { stdTime: "-1", stdTimeUnit: "HOURS", stdTimeBasis: "PER_PIECE" },
        }),
      ).rejects.toThrow(/check constraint/i);
    });

    it("accepts a complete standard time, and leaves untouched steps at today's defaults", async () => {
      const untouched = await owner.routeStep.findUniqueOrThrow({ where: { id: a.step.id } });
      expect(untouched.stdTime).toBeNull();
      expect(untouched.stdTimeStatus).toBe("PROPOSED");
      expect(untouched.requiresQc).toBe(true);
      expect(untouched.departmentId).toBeNull();
      expect(untouched.includeWhen).toBeNull();

      const step2 = await owner.routeStep.create({
        data: {
          routeVersionId: a.routeVersion.id,
          seq: 20,
          operationId: a.operation.id,
          departmentId: a.dept.id,
          stdTime: "0.75",
          stdTimeUnit: "HOURS",
          stdTimeBasis: "PER_METRE_CUT",
          conditionText: "Only for segmented construction",
          includeWhen: { all: [{ key: "segmented", op: "truthy" }] },
        },
      });
      expect(step2.stdTime?.toString()).toBe("0.75");
    });
  });

  describe("route_step_family_seqs", () => {
    it("is unique per (step, family) and cascades with its step", async () => {
      await owner.routeStepFamilySeq.create({
        data: { tenantId: a.tenantId, routeStepId: a.step.id, familyId: a.family.id, leadTimeProcessSeq: 11 },
      });
      await expect(
        owner.routeStepFamilySeq.create({
          data: { tenantId: a.tenantId, routeStepId: a.step.id, familyId: a.family.id, leadTimeProcessSeq: 12 },
        }),
      ).rejects.toThrow(/Unique constraint/i);
    });
  });

  describe("material_grades", () => {
    it("rejects a duplicate (tenant, spec, grade, form) and a non-positive density", async () => {
      await owner.materialGrade.create({
        data: { tenantId: a.tenantId, spec: "SA 516", grade: "Gr.70", productForm: "Plate", densityGcc: "7.85" },
      });
      await expect(
        owner.materialGrade.create({
          data: { tenantId: a.tenantId, spec: "SA 516", grade: "Gr.70", productForm: "Plate" },
        }),
      ).rejects.toThrow(/Unique constraint/i);
      await expect(
        owner.materialGrade.create({
          data: { tenantId: a.tenantId, spec: "SA 516", grade: "Gr.60", productForm: "Plate", densityGcc: "0" },
        }),
      ).rejects.toThrow(/material_grades_density_chk|check constraint/i);
    });

    it("allows the same (spec, grade, form) in another tenant", async () => {
      const row = await owner.materialGrade.create({
        data: { tenantId: b.tenantId, spec: "SA 516", grade: "Gr.70", productForm: "Plate" },
      });
      expect(row.status).toBe("DRAFT");
      expect(row.grade).toBe("Gr.70");
    });
  });

  describe("tenant isolation for the app role (despl_web)", () => {
    it("part_families, material_grades and route_step_family_seqs: tenant A sees only its own rows", async () => {
      const tA = await newPartFamilyType(a);
      const tB = await newPartFamilyType(b);
      const pfA = await owner.partFamily.create({ data: { tenantId: a.tenantId, componentTypeId: tA.id } });
      const pfB = await owner.partFamily.create({ data: { tenantId: b.tenantId, componentTypeId: tB.id } });
      const mgB = await owner.materialGrade.create({
        data: { tenantId: b.tenantId, spec: "SA 106", grade: "Gr.B", productForm: "Pipe" },
      });
      const seqB = await owner.routeStepFamilySeq.create({
        data: { tenantId: b.tenantId, routeStepId: b.step.id, familyId: b.family.id, leadTimeProcessSeq: 19 },
      });

      const seen = await withTenant(a.tenantId, async (tx) => ({
        pf: await tx.partFamily.findMany({ where: { id: { in: [pfA.id, pfB.id] } } }),
        mg: await tx.materialGrade.findMany({ where: { id: mgB.id } }),
        seq: await tx.routeStepFamilySeq.findMany({ where: { id: seqB.id } }),
      }));
      expect(seen.pf.map((r) => r.id)).toEqual([pfA.id]);
      expect(seen.mg).toHaveLength(0);
      expect(seen.seq).toHaveLength(0);
    });

    it("tenant A cannot insert a row carrying tenant B's tenant_id", async () => {
      const t = await newPartFamilyType(a);
      await expect(
        withTenant(a.tenantId, (tx) => tx.partFamily.create({ data: { tenantId: b.tenantId, componentTypeId: t.id } })),
      ).rejects.toThrow();
      await expect(
        withTenant(a.tenantId, (tx) =>
          tx.materialGrade.create({ data: { tenantId: b.tenantId, spec: "X", productForm: "Plate" } }),
        ),
      ).rejects.toThrow();
    });

    it("no tenant GUC set -> zero rows (fails closed)", async () => {
      const { prisma } = await import("@/lib/db");
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
        return tx.materialGrade.findMany({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } });
      });
      expect(rows).toHaveLength(0);
    });

    it("the app role can write its own tenant's master data", async () => {
      const t = await newPartFamilyType(a);
      const created = await withTenant(a.tenantId, (tx) =>
        tx.partFamily.create({ data: { tenantId: a.tenantId, componentTypeId: t.id, assemblyGroup: "Shell" } }),
      );
      expect(created.assemblyGroup).toBe("Shell");
    });
  });

  describe("defaults preserve today's behaviour", () => {
    it("existing component types are RAW_FORM", async () => {
      const t = await owner.componentTypeRef.findUniqueOrThrow({ where: { id: a.rawForm.id } });
      expect(t.kind).toBe("RAW_FORM");
    });
  });
});
