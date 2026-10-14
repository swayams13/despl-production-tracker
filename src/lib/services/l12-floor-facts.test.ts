import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Lean Core L1.2b — proves migration 20261014120000_l12_floor_facts: the
 * at-risk release CHECK, `work_requests` tenant isolation and append-only
 * grants, defaults that preserve today's behaviour, and the intake copy points
 * (assembly step role / jointRef / pressurePart; component pressureRetaining).
 *
 * Same disposable-org pattern as l11-lean-additive.test.ts. Violation cases first.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org codes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core L1.2b floor facts migration (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant, prisma } = await import("@/lib/db");
  const { materializeAssemblyStepsFromTemplate } = await import("./assembly.service");
  const { materializeComponentsFromBomItems } = await import("./component.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  async function fixture(suffix: string) {
    const stamp = `${Date.now()}-${Math.random()}`;
    const org = await owner.organization.create({ data: { code: `TEST-L12B-${suffix}-${stamp}`, name: `l12b ${suffix}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${suffix}-${stamp}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: { tenantId, publicId: `pub-l12b-${suffix}-${stamp}`, clientId: client.id, familyId: family.id, templateVersionId: tv.id, jobNumber: `JOB-L12B-${suffix}-${stamp}` },
    });
    const user = await owner.user.create({
      data: { tenantId, email: `l12b-${suffix}-${stamp}@test.local`, username: `l12b-${suffix}-${stamp}`, passwordHash: "x", name: "L12B User" },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "01" } });
    const drawingType = await owner.drawingTypeRef.create({ data: { tenantId, code: "GA", name: "GA" } });
    const drawing = await owner.assemblyDrawing.create({ data: { jobId: job.id, drawingTypeId: drawingType.id, drawingNo: `GA-${stamp}` } });
    const revision = await owner.drawingRevision.create({ data: { jobId: job.id, assemblyDrawingId: drawing.id, revisionNo: 0 } });
    return { tenantId, dept, family, job, user, equipment, unit, revision };
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

  describe("drawing_revisions at-risk release CHECK (first three all set or all null)", () => {
    const now = () => new Date();
    it.each<[string, () => Record<string, unknown>]>([
      ["by only", () => ({ atRiskReleasedById: a.user.id })],
      ["at only", () => ({ atRiskReleasedAt: now() })],
      ["reason only", () => ({ atRiskReason: "client asked" })],
      ["by + at, no reason", () => ({ atRiskReleasedById: a.user.id, atRiskReleasedAt: now() })],
      ["by + reason, no at", () => ({ atRiskReleasedById: a.user.id, atRiskReason: "x" })],
      ["at + reason, no by", () => ({ atRiskReleasedAt: now(), atRiskReason: "x" })],
    ])("refuses a partial release: %s", async (_label, data) => {
      await expect(owner.drawingRevision.update({ where: { id: a.revision.id }, data: data() })).rejects.toThrow(/check constraint/i);
    });

    it("client consent alone is allowed (it is optional, outside the CHECK)", async () => {
      await owner.drawingRevision.update({ where: { id: a.revision.id }, data: { clientConsentRef: "MAIL-1" } });
      await owner.drawingRevision.update({ where: { id: a.revision.id }, data: { clientConsentRef: null } });
    });

    it("accepts all three set, and all three cleared", async () => {
      const set = await owner.drawingRevision.update({
        where: { id: a.revision.id },
        data: { atRiskReleasedById: a.user.id, atRiskReleasedAt: now(), atRiskReason: "client asked", clientConsentRef: "MAIL-1" },
      });
      expect(set.atRiskReleasedById).toBe(a.user.id);
      const cleared = await owner.drawingRevision.update({
        where: { id: a.revision.id },
        data: { atRiskReleasedById: null, atRiskReleasedAt: null, atRiskReason: null, clientConsentRef: null },
      });
      expect(cleared.atRiskReleasedAt).toBeNull();
    });
  });

  describe("work_requests: tenant isolation and append-only grants", () => {
    const seed = (f: typeof a, response: object = { applied: [] }) =>
      owner.workRequest.create({ data: { jobId: f.job.id, requestId: crypto.randomUUID(), actorId: f.user.id, response } });

    it("tenant A cannot read tenant B's rows, nor insert one for tenant B's job", async () => {
      const bRow = await seed(b);
      expect(await withTenant(a.tenantId, (tx) => tx.workRequest.findMany({ where: { id: bRow.id } }))).toHaveLength(0);
      await expect(
        withTenant(a.tenantId, (tx) =>
          tx.workRequest.create({ data: { jobId: b.job.id, requestId: crypto.randomUUID(), actorId: a.user.id, response: {} } }),
        ),
      ).rejects.toThrow();
    });

    it("no tenant GUC set at all -> zero rows (fails closed)", async () => {
      const row = await seed(a);
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
        return tx.workRequest.findMany({ where: { id: row.id } });
      });
      expect(rows).toHaveLength(0);
    });

    it("append-only: despl_web cannot UPDATE, DELETE or TRUNCATE", async () => {
      const row = await seed(a, { kept: true });
      await expect(
        withTenant(a.tenantId, (tx) => tx.$executeRaw`UPDATE work_requests SET response = '{}' WHERE id = ${row.id}`),
      ).rejects.toThrow(/permission denied/i);
      await expect(withTenant(a.tenantId, (tx) => tx.$executeRaw`DELETE FROM work_requests WHERE id = ${row.id}`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(withTenant(a.tenantId, (tx) => tx.$executeRaw`TRUNCATE work_requests`)).rejects.toThrow(/permission denied/i);
      expect((await owner.workRequest.findUniqueOrThrow({ where: { id: row.id } })).response).toEqual({ kept: true });
    });

    it("a requestId is unique per tenant: a second insert is refused", async () => {
      const row = await seed(a);
      await expect(
        owner.workRequest.create({ data: { jobId: a.job.id, requestId: row.requestId, actorId: a.user.id, response: {} } }),
      ).rejects.toThrow(/unique constraint/i);
    });

    it("the aud001 trigger derives tenant_id; despl_web can INSERT and SELECT its own tenant's rows", async () => {
      const created = await withTenant(a.tenantId, (tx) =>
        tx.workRequest.create({ data: { jobId: a.job.id, requestId: crypto.randomUUID(), actorId: a.user.id, response: { ok: 1 } } }),
      );
      expect(created.tenantId).toBe(a.tenantId);
      expect(await withTenant(a.tenantId, (tx) => tx.workRequest.findMany({ where: { id: created.id } }))).toHaveLength(1);
    });
  });

  describe("defaults preserve today's behaviour", () => {
    it("new columns default to null / false on every table", async () => {
      const tpl = await owner.assemblyTemplate.create({ data: { tenantId: a.tenantId, familyId: a.family.id, name: "defaults" } });
      const v = await owner.assemblyTemplateVersion.create({ data: { templateId: tpl.id, version: 1 } });
      const ts = await owner.assemblyTemplateStep.create({
        data: { versionId: v.id, seq: 1, groupCode: "A", groupName: "A", srNo: "1", activity: "x", kind: "WORK", defaultDepartmentId: a.dept.id },
      });
      const step = await owner.assemblyStep.create({ data: { jobId: a.job.id, unitId: a.unit.id, templateStepId: ts.id, seq: 9001 } });
      const type = await owner.componentTypeRef.create({ data: { tenantId: a.tenantId, code: `DEF-${Date.now()}`, name: "d" } });
      const part = await owner.partFamily.create({ data: { tenantId: a.tenantId, componentTypeId: type.id } });
      const comp = await owner.component.create({
        data: { jobId: a.job.id, equipmentId: a.equipment.id, tag: `DEF-${Date.now()}`, componentTypeId: type.id },
      });
      const so = await owner.sequenceOverride.create({
        data: { jobId: a.job.id, targetKind: "ASSEMBLY_STEP", targetId: step.id, category: "OTHER", createdBy: a.user.id },
      });
      const rev = await owner.drawingRevision.findUniqueOrThrow({ where: { id: b.revision.id } });

      expect([ts.role, ts.pressurePart]).toEqual([null, false]);
      expect([step.role, step.jointRef, step.pressurePart]).toEqual([null, null, false]);
      expect(part.pressureRetaining).toBe(false);
      expect(comp.pressureRetaining).toBe(false);
      expect(so.predecessorTargetId).toBeNull();
      expect([rev.atRiskReleasedById, rev.atRiskReleasedAt, rev.atRiskReason, rev.clientConsentRef]).toEqual([null, null, null, null]);
    });
  });

  describe("materializeAssemblyStepsFromTemplate copies role / jointRef / pressurePart to the job rows", () => {
    it("copies per step; a v1-shaped step (no role data) stays null / false", async () => {
      // A separate family so the tenant's other assembly template (defaults test) is not picked.
      const family = await owner.productFamily.create({ data: { tenantId: a.tenantId, code: `PV-ASM-${Date.now()}`, name: "PV asm" } });
      const tpl = await owner.assemblyTemplate.create({ data: { tenantId: a.tenantId, familyId: family.id, name: "A-Q" } });
      const v = await owner.assemblyTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
      const base = { versionId: v.id, groupCode: "E", groupName: "LS", srNo: "4.5", kind: "WORK" as const, defaultDepartmentId: a.dept.id };
      await owner.assemblyTemplateStep.createMany({
        data: [
          { ...base, seq: 1, activity: "Fit-up LS-1", role: "FIT_UP", jointRef: "LS-1", pressurePart: true },
          { ...base, seq: 2, activity: "Weld LS-1", role: "WELD", jointRef: "LS-1", pressurePart: true },
          { ...base, seq: 3, activity: "Nameplate", jointRef: null },
        ],
      });
      const unit = await owner.unit.create({ data: { jobId: a.job.id, equipmentId: a.equipment.id, serialNo: `ASM-${Date.now()}` } });

      await withTenant(a.tenantId, (tx) => materializeAssemblyStepsFromTemplate(tx, a.tenantId, a.job.id, family.id, [unit.id], null));

      const rows = await owner.assemblyStep.findMany({ where: { unitId: unit.id }, orderBy: { seq: "asc" } });
      expect(rows.map((r) => [r.seq, r.role, r.jointRef, r.pressurePart])).toEqual([
        [1, "FIT_UP", "LS-1", true],
        [2, "WELD", "LS-1", true],
        [3, null, null, false],
      ]);
    });
  });

  describe("materializeComponentsFromBomItems copies pressureRetaining from the APPROVED part family only", () => {
    const op = () =>
      owner.operationRef.upsert({
        where: { tenantId_code: { tenantId: a.tenantId, code: "CUTTING" } },
        update: {},
        create: { tenantId: a.tenantId, code: "CUTTING", name: "Cutting" },
      });

    it.each<[string, null | { status: "DRAFT" | "REVIEWED" | "APPROVED"; pressureRetaining: boolean }, boolean]>([
      ["DRAFT family flagged true -> false", { status: "DRAFT", pressureRetaining: true }, false],
      ["REVIEWED family flagged true -> false", { status: "REVIEWED", pressureRetaining: true }, false],
      ["no part family -> false", null, false],
      ["APPROVED family flagged false -> false", { status: "APPROVED", pressureRetaining: false }, false],
      ["APPROVED family flagged true -> true", { status: "APPROVED", pressureRetaining: true }, true],
    ])("%s", async (_label, family, expected) => {
      const n = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const type = await owner.componentTypeRef.create({ data: { tenantId: a.tenantId, code: `PR-${n}`, name: `PR ${n}` } });
      if (family) {
        await owner.partFamily.create({
          data: {
            tenantId: a.tenantId,
            componentTypeId: type.id,
            ...family,
            ...(family.status === "APPROVED" ? { approvedById: a.user.id, approvedAt: new Date() } : {}),
          },
        });
      }
      const route = await owner.routeTemplate.create({ data: { tenantId: a.tenantId, componentTypeId: type.id, familyId: a.family.id, name: "R" } });
      const rv = await owner.routeTemplateVersion.create({ data: { routeId: route.id, version: 1, status: "PUBLISHED" } });
      await owner.routeStep.create({ data: { routeVersionId: rv.id, seq: 10, operationId: (await op()).id } });
      const bom = await owner.bomItem.create({
        data: { jobId: a.job.id, equipmentId: a.equipment.id, itemNo: 500, partName: `P-${n}`, sourceQty: "1", componentTypeId: type.id },
      });

      await withTenant(a.tenantId, (tx) => materializeComponentsFromBomItems(tx, a.family.id, a.equipment.id, [bom.id], a.job.id));

      const comps = await owner.component.findMany({ where: { bomItemId: bom.id } });
      expect(comps.length).toBeGreaterThan(0);
      for (const c of comps) expect(c.pressureRetaining).toBe(expected);
    });
  });
});
