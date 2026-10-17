import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Lean Core L1.1 — proves migration 20261012120000_l11_lean_core_additive:
 * every new column takes the value that preserves today's behaviour, the new
 * `units.public_id` is filled and unique, the reported-time CHECKs hold, and
 * `sequence_overrides` is tenant-isolated and append-only for the app role.
 *
 * Same disposable-org pattern as check-constraints.test.ts and
 * aud001-tenant-isolation-rls.test.ts: `owner` (DIRECT_URL, bypasses RLS)
 * builds fixtures across two real tenants; `withTenant` (despl_web, RLS-subject)
 * makes the isolation and grant assertions. Gated behind RUN_DB_TESTS.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org codes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core L1.1 additive migration (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  async function fixture(suffix: string) {
    const stamp = `${Date.now()}-${Math.random()}`;
    const org = await owner.organization.create({ data: { code: `TEST-L11-${suffix}-${stamp}`, name: `l11 ${suffix}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${suffix}-${stamp}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-l11-${suffix}-${stamp}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `JOB-L11-${suffix}-${stamp}`,
      },
    });
    const user = await owner.user.create({
      data: { tenantId, email: `l11-${suffix}-${stamp}@test.local`, username: `l11-${suffix}-${stamp}`, passwordHash: "x", name: "L11 User" },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unitA = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "01" } });
    const unitB = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "02" } });

    const tp1 = await owner.templateProcess.create({
      data: { versionId: tv.id, seq: 1, code: "T1", name: "T1", defaultDepartmentId: dept.id },
    });
    const tp2 = await owner.templateProcess.create({
      data: { versionId: tv.id, seq: 2, code: "T2", name: "T2", defaultDepartmentId: dept.id },
    });
    const templateEdge = await owner.templateEdge.create({
      data: { versionId: tv.id, processId: tp2.id, predecessorId: tp1.id, type: "FINISH_TO_START", lagDays: 0 },
    });
    const jp1 = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 1, code: "P1", name: "P1", departmentId: dept.id, workOrderStages: [1] },
    });
    const jp2 = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 2, code: "P2", name: "P2", departmentId: dept.id, workOrderStages: [2] },
    });
    const edge = await owner.jobProcessEdge.create({
      data: { jobId: job.id, processId: jp2.id, predecessorId: jp1.id, type: "FINISH_TO_START", lagDays: 0 },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    const plan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp1.id, unitId: unitA.id, ownerDepartmentId: dept.id },
    });
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const operation = await owner.operationRef.create({ data: { tenantId, code: "CUTTING", name: "Cutting" } });
    const bomItem = await owner.bomItem.create({
      data: { jobId: job.id, equipmentId: equipment.id, itemNo: 1, partName: "Shell", sourceQty: "1", componentTypeId: componentType.id },
    });
    const component = await owner.component.create({
      data: { jobId: job.id, equipmentId: equipment.id, bomItemId: bomItem.id, tag: "SHELL-1", componentTypeId: componentType.id },
    });
    const componentOp = await owner.componentOperation.create({
      data: { jobId: job.id, componentId: component.id, seq: 1, operationId: operation.id },
    });
    const asmTemplate = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "A-Q" } });
    const asmVersion = await owner.assemblyTemplateVersion.create({ data: { templateId: asmTemplate.id, version: 1 } });
    const templateStep = await owner.assemblyTemplateStep.create({
      data: { versionId: asmVersion.id, seq: 1, groupCode: "C", groupName: "Shell Prep", srNo: "4.1", activity: "Cut", kind: "WORK", defaultDepartmentId: dept.id },
    });
    const assemblyStep = await owner.assemblyStep.create({
      data: { jobId: job.id, unitId: unitA.id, templateStepId: templateStep.id, seq: 1 },
    });

    return {
      tenantId,
      jobId: job.id,
      userId: user.id,
      unitAId: unitA.id,
      unitBId: unitB.id,
      tp1,
      templateEdge,
      jp1,
      edge,
      plan,
      operation,
      componentOp,
      templateStep,
      assemblyStep,
    };
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

  describe("defaults preserve today's behaviour", () => {
    it("template and job processes default to UNIT grain and requiresQc = true", async () => {
      const tp = await owner.templateProcess.findUniqueOrThrow({ where: { id: a.tp1.id } });
      const jp = await owner.jobProcess.findUniqueOrThrow({ where: { id: a.jp1.id } });
      for (const row of [tp, jp]) {
        expect(row.grain).toBe("UNIT");
        expect(row.requiresQc).toBe(true);
      }
    });

    it("template and job edges default to HARD", async () => {
      const te = await owner.templateEdge.findUniqueOrThrow({ where: { id: a.templateEdge.id } });
      const je = await owner.jobProcessEdge.findUniqueOrThrow({ where: { id: a.edge.id } });
      expect(te.enforcement).toBe("HARD");
      expect(je.enforcement).toBe("HARD");
    });

    it("operation refs, assembly template steps, component operations and assembly steps default to requiresQc = true", async () => {
      expect((await owner.operationRef.findUniqueOrThrow({ where: { id: a.operation.id } })).requiresQc).toBe(true);
      expect((await owner.assemblyTemplateStep.findUniqueOrThrow({ where: { id: a.templateStep.id } })).requiresQc).toBe(true);
      expect((await owner.componentOperation.findUniqueOrThrow({ where: { id: a.componentOp.id } })).requiresQc).toBe(true);
      expect((await owner.assemblyStep.findUniqueOrThrow({ where: { id: a.assemblyStep.id } })).requiresQc).toBe(true);
    });

    it("reported times are null on process plans, component operations and assembly steps", async () => {
      const plan = await owner.processPlan.findUniqueOrThrow({ where: { id: a.plan.id } });
      const op = await owner.componentOperation.findUniqueOrThrow({ where: { id: a.componentOp.id } });
      const step = await owner.assemblyStep.findUniqueOrThrow({ where: { id: a.assemblyStep.id } });
      for (const row of [plan, op, step]) {
        expect(row.reportedStartAt).toBeNull();
        expect(row.reportedFinishAt).toBeNull();
      }
    });

    it("users default to locale 'en'", async () => {
      const user = await owner.user.findUniqueOrThrow({ where: { id: a.userId } });
      expect(user.locale).toBe("en");
    });

    it("setOwnLocale (L2.12) writes the caller's own locale as the app role", async () => {
      const { setOwnLocale } = await import("@/lib/auth/preferences");
      await setOwnLocale({ userId: a.userId, tenantId: a.tenantId } as Parameters<typeof setOwnLocale>[0], "hi");
      expect((await owner.user.findUniqueOrThrow({ where: { id: a.userId } })).locale).toBe("hi");
    });
  });

  describe("units.public_id", () => {
    it("is filled by the database default and distinct per unit", async () => {
      const units = await owner.unit.findMany({ where: { id: { in: [a.unitAId, a.unitBId] } } });
      expect(units).toHaveLength(2);
      for (const u of units) expect(u.publicId).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Set(units.map((u) => u.publicId)).size).toBe(2);
    });

    it("is unique: a duplicate is refused", async () => {
      const other = await owner.unit.findUniqueOrThrow({ where: { id: a.unitAId } });
      await expect(owner.unit.update({ where: { id: a.unitBId }, data: { publicId: other.publicId } })).rejects.toThrow(
        /unique constraint/i,
      );
    });
  });

  describe("reported-time CHECK constraints", () => {
    it.each<[string, () => number]>([
      ["process_plans", () => a.plan.id],
      ["component_operations", () => a.componentOp.id],
      ["assembly_steps", () => a.assemblyStep.id],
    ])("%s: a reported finish before the reported start is refused; one side alone is fine", async (table, id) => {
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE ${table} SET reported_start_at = now(), reported_finish_at = now() - interval '1 day' WHERE id = $1`,
          id(),
        ),
      ).rejects.toThrow(/check constraint/i);

      await expect(
        owner.$executeRawUnsafe(`UPDATE ${table} SET reported_start_at = now(), reported_finish_at = NULL WHERE id = $1`, id()),
      ).resolves.toBe(1);
      await expect(
        owner.$executeRawUnsafe(`UPDATE ${table} SET reported_start_at = NULL, reported_finish_at = now() WHERE id = $1`, id()),
      ).resolves.toBe(1);
      await owner.$executeRawUnsafe(`UPDATE ${table} SET reported_start_at = NULL, reported_finish_at = NULL WHERE id = $1`, id());
    });
  });

  describe("sequence_overrides: tenant isolation and append-only grants", () => {
    async function seedOverride(f: typeof a, note: string) {
      // Written as the table owner; the aud001 trigger derives tenant_id from job_id.
      return owner.sequenceOverride.create({
        data: {
          jobId: f.jobId,
          targetKind: "PROCESS_PLAN",
          targetId: f.plan.id,
          unitId: f.unitAId,
          edgeId: f.edge.id,
          category: "MATERIAL_NOT_READY",
          note,
          createdBy: f.userId,
        },
      });
    }

    it("the aud001 trigger derives tenant_id from job_id", async () => {
      const row = await seedOverride(a, "derive");
      expect(row.tenantId).toBe(a.tenantId);
    });

    it("the app role (despl_web) can INSERT and SELECT its own tenant's rows", async () => {
      const created = await withTenant(a.tenantId, (tx) =>
        tx.sequenceOverride.create({
          data: { jobId: a.jobId, targetKind: "COMPONENT_OP", targetId: a.componentOp.id, category: "OTHER", createdBy: a.userId },
        }),
      );
      expect(created.tenantId).toBe(a.tenantId);
      const rows = await withTenant(a.tenantId, (tx) => tx.sequenceOverride.findMany({ where: { id: created.id } }));
      expect(rows).toHaveLength(1);
    });

    it("tenant A cannot read tenant B's rows, and cannot insert a row for tenant B's job", async () => {
      const bRow = await seedOverride(b, "b-row");
      const seen = await withTenant(a.tenantId, (tx) => tx.sequenceOverride.findMany({ where: { id: bRow.id } }));
      expect(seen).toHaveLength(0);

      await expect(
        withTenant(a.tenantId, (tx) =>
          tx.sequenceOverride.create({
            data: { jobId: b.jobId, targetKind: "PROCESS_PLAN", targetId: b.plan.id, category: "OTHER", createdBy: a.userId },
          }),
        ),
      ).rejects.toThrow();
    });

    it("no tenant GUC set at all -> zero rows (fails closed)", async () => {
      const row = await seedOverride(a, "no-guc");
      const { prisma } = await import("@/lib/db");
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
        return tx.sequenceOverride.findMany({ where: { id: row.id } });
      });
      expect(rows).toHaveLength(0);
    });

    it("append-only: despl_web cannot UPDATE, DELETE or TRUNCATE", async () => {
      const row = await seedOverride(a, "immutable");
      await expect(
        withTenant(a.tenantId, (tx) => tx.$executeRaw`UPDATE sequence_overrides SET note = 'edited' WHERE id = ${row.id}`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        withTenant(a.tenantId, (tx) => tx.$executeRaw`DELETE FROM sequence_overrides WHERE id = ${row.id}`),
      ).rejects.toThrow(/permission denied/i);
      await expect(withTenant(a.tenantId, (tx) => tx.$executeRaw`TRUNCATE sequence_overrides`)).rejects.toThrow(
        /permission denied/i,
      );
      const untouched = await owner.sequenceOverride.findUniqueOrThrow({ where: { id: row.id } });
      expect(untouched.note).toBe("immutable");
    });
  });

  describe("roles", () => {
    it("the DESPL org has OPERATOR, PLANNER, STORES and ENGINEERING (migration insert on an existing org, seed on a fresh one)", async () => {
      const org = await owner.organization.findUnique({ where: { code: "DESPL" }, select: { id: true } });
      if (!org) return; // DB was not seeded; nothing to check
      const codes = (await owner.role.findMany({ where: { tenantId: org.id }, select: { code: true } })).map((r) => r.code);
      for (const c of ["OPERATOR", "PLANNER", "STORES", "ENGINEERING"]) expect(codes).toContain(c);
    });
  });
});
