import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Lean Core M1 (PR B) — the two behaviour changes on top of PR A's schema:
 *   1. rollup gates (`loadMappedOps` / `assertComponentOpsComplete` /
 *      `assertNoOpenNcr`) resolve a step-level `RouteStepFamilySeq` first,
 *      then the operation-level `OperationRefFamilySeq` default;
 *   2. `materializeComponentsFromBomItems` picks a route variant
 *      deterministically and ANDs the step's `requiresQc` with the operation's.
 * Plus `createOrReviseRouteTemplate` honouring `variant`.
 *
 * With no step-level rows every gate must behave exactly as before — the first
 * case of each block pins that. Gated behind RUN_DB_TESTS.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org codes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core M1 PR B — step-level stage mapping and variant pick (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { ROLES } = await import("@/lib/authz");
  const { ERROR_CODES } = await import("@/lib/shared/errors");
  const { loadMappedOps, assertComponentOpsComplete, assertNoOpenNcr } = await import("./_shared");
  const { materializeComponentsFromBomItems } = await import("./component.service");
  const { createOrReviseRouteTemplate } = await import("./route.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const stamp = `${Date.now()}-${Math.random()}`;
  let f: Awaited<ReturnType<typeof build>>;

  async function build() {
    const org = await owner.organization.create({ data: { code: `TEST-M1B-${stamp}`, name: "m1b" } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${stamp}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const otherFamily = await owner.productFamily.create({ data: { tenantId, code: "PIPE_SPOOL", name: "Spool" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "T" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: { tenantId, publicId: `pub-m1b-${stamp}`, clientId: client.id, familyId: family.id, templateVersionId: tv.id, jobNumber: `JOB-M1B-${stamp}` },
    });
    const user = await owner.user.create({
      data: { tenantId, email: `m1b-${stamp}@test.local`, username: `m1b-${stamp}`, passwordHash: "x", name: "M1B" },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "01" } });
    const p11 = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 1, code: "11", name: "P11", departmentId: dept.id, workOrderStages: [1] },
    });
    const p18 = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 2, code: "18", name: "P18", departmentId: dept.id, workOrderStages: [2] },
    });
    const rawForm = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const inspection = await owner.operationRef.create({ data: { tenantId, code: "INSPECTION", name: "Inspection" } });
    const fitup = await owner.operationRef.create({ data: { tenantId, code: "FITUP", name: "Fit-up" } });
    const machining = await owner.operationRef.create({ data: { tenantId, code: "MACHINING", name: "Machining" } });
    const route = await owner.routeTemplate.create({
      data: { tenantId, componentTypeId: rawForm.id, familyId: family.id, name: "Plate route" },
    });
    const rv = await owner.routeTemplateVersion.create({ data: { routeId: route.id, version: 1 } });
    const step10 = await owner.routeStep.create({ data: { routeVersionId: rv.id, seq: 10, operationId: inspection.id } });
    const step20 = await owner.routeStep.create({ data: { routeVersionId: rv.id, seq: 20, operationId: fitup.id } });
    const step30 = await owner.routeStep.create({ data: { routeVersionId: rv.id, seq: 30, operationId: machining.id } });
    // Operation-level default: Inspection and Fit-up -> process 11. Machining unmapped.
    await owner.operationRefFamilySeq.create({
      data: { tenantId, operationRefId: inspection.id, familyId: family.id, leadTimeProcessSeq: 11 },
    });
    await owner.operationRefFamilySeq.create({
      data: { tenantId, operationRefId: fitup.id, familyId: family.id, leadTimeProcessSeq: 11 },
    });
    const bomItem = await owner.bomItem.create({
      data: { jobId: job.id, equipmentId: equipment.id, itemNo: 1, partName: "Shell", sourceQty: "1", componentTypeId: rawForm.id },
    });
    const component = await owner.component.create({
      data: { jobId: job.id, equipmentId: equipment.id, unitId: unit.id, bomItemId: bomItem.id, tag: "SHELL-1", componentTypeId: rawForm.id, routeVersionId: rv.id },
    });
    const mkOp = (seq: number, operationId: number, status: "NOT_STARTED" | "COMPLETE" = "NOT_STARTED") =>
      owner.componentOperation.create({ data: { jobId: job.id, componentId: component.id, seq, operationId, status } });
    const opInspection = await mkOp(10, inspection.id);
    const opFitup = await mkOp(20, fitup.id, "COMPLETE");
    const opMachining = await mkOp(30, machining.id);
    const category = await owner.delayCategoryRef.create({ data: { tenantId, code: "REJ", name: "Rejection" } });
    return {
      tenantId, dept, family, otherFamily, job, user, equipment, unit, p11, p18, rawForm,
      inspection, fitup, machining, route, rv, step10, step20, step30, bomItem, component,
      opInspection, opFitup, opMachining, category,
    };
  }

  const actorFor = () => ({
    userId: f.user.id,
    tenantId: f.tenantId,
    clientId: null,
    name: "M1B",
    email: `m1b-${stamp}@test.local`,
    roles: [ROLES.ADMIN],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM" as const,
    outdoorMode: false,
  });

  const labels = async (jobProcessId: number) =>
    (await withTenant(f.tenantId, (tx) => loadMappedOps(tx, { jobProcessId, unitId: f.unit.id, jobId: f.job.id })))
      .filter((o) => o.source === "fabrication")
      .map((o) => o.label)
      .sort();

  beforeAll(async () => {
    f = await build();
  });
  beforeEach(async () => {
    await owner.routeStepFamilySeq.deleteMany({ where: { tenantId: f.tenantId } });
    await owner.ncr.deleteMany({ where: { jobId: f.job.id } });
    await owner.componentOperationRejection.deleteMany({ where: { jobId: f.job.id } });
    await owner.componentOperation.update({ where: { id: f.opInspection.id }, data: { status: "NOT_STARTED" } });
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const stepRow = (routeStepId: number, familyId: number, leadTimeProcessSeq: number) =>
    owner.routeStepFamilySeq.create({ data: { tenantId: f.tenantId, routeStepId, familyId, leadTimeProcessSeq } });

  describe("loadMappedOps / assertComponentOpsComplete", () => {
    it("no step-level rows: rolls up by the operation-level default, exactly as before", async () => {
      expect(await labels(f.p11.id)).toEqual(["Fit-up", "Inspection"]);
      expect(await labels(f.p18.id)).toEqual([]);
    });

    it("a step-level row moves that one step to another process", async () => {
      await stepRow(f.step10.id, f.family.id, 18);
      expect(await labels(f.p11.id)).toEqual(["Fit-up"]);
      expect(await labels(f.p18.id)).toEqual(["Inspection"]);
    });

    it("a step-level row picks up an operation that has no operation-level mapping", async () => {
      await stepRow(f.step30.id, f.family.id, 18);
      expect(await labels(f.p18.id)).toEqual(["Machining"]);
      expect(await labels(f.p11.id)).toEqual(["Fit-up", "Inspection"]);
    });

    it("another family's step-level row has no effect on this job", async () => {
      await stepRow(f.step10.id, f.otherFamily.id, 18);
      expect(await labels(f.p11.id)).toEqual(["Fit-up", "Inspection"]);
      expect(await labels(f.p18.id)).toEqual([]);
    });

    it("the completeness gate follows the step-level mapping", async () => {
      // Inspection (NOT_STARTED) rolls into 11 by default -> 11 is blocked, 18 is not.
      await expect(
        withTenant(f.tenantId, (tx) => assertComponentOpsComplete(tx, { jobProcessId: f.p11.id, unitId: f.unit.id, jobId: f.job.id })),
      ).rejects.toMatchObject({ code: ERROR_CODES.COMPONENT_OPS_INCOMPLETE });
      await withTenant(f.tenantId, (tx) =>
        assertComponentOpsComplete(tx, { jobProcessId: f.p18.id, unitId: f.unit.id, jobId: f.job.id }),
      );

      // Move Inspection's step to 18: now 18 is blocked and 11 (only Fit-up, COMPLETE) is clear.
      await stepRow(f.step10.id, f.family.id, 18);
      await withTenant(f.tenantId, (tx) =>
        assertComponentOpsComplete(tx, { jobProcessId: f.p11.id, unitId: f.unit.id, jobId: f.job.id }),
      );
      await expect(
        withTenant(f.tenantId, (tx) => assertComponentOpsComplete(tx, { jobProcessId: f.p18.id, unitId: f.unit.id, jobId: f.job.id })),
      ).rejects.toMatchObject({ code: ERROR_CODES.COMPONENT_OPS_INCOMPLETE });
    });
  });

  describe("assertNoOpenNcr", () => {
    async function openNcrOnInspection() {
      const rejection = await owner.componentOperationRejection.create({
        data: { jobId: f.job.id, componentOperationId: f.opInspection.id, categoryId: f.category.id, rejectedBy: f.user.id },
      });
      await owner.ncr.create({ data: { jobId: f.job.id, componentOperationRejectionId: rejection.id, status: "OPEN" } });
    }
    const gate = (jobProcessId: number) =>
      withTenant(f.tenantId, (tx) => assertNoOpenNcr(tx, { jobProcessId, unitId: f.unit.id, jobId: f.job.id }));

    it("no step-level rows: the NCR blocks the process the operation maps to, as before", async () => {
      await openNcrOnInspection();
      await expect(gate(f.p11.id)).rejects.toMatchObject({ code: ERROR_CODES.NCR_OPEN });
      await gate(f.p18.id);
    });

    it("a step-level row moves the block to the process that step now counts toward", async () => {
      await openNcrOnInspection();
      await stepRow(f.step10.id, f.family.id, 18);
      await gate(f.p11.id);
      await expect(gate(f.p18.id)).rejects.toMatchObject({ code: ERROR_CODES.NCR_OPEN });
    });
  });

  describe("materializeComponentsFromBomItems — variant pick and effective QC", () => {
    // Fresh component type per case so routes never collide.
    let n = 0;
    async function newType() {
      n += 1;
      const type = await owner.componentTypeRef.create({
        data: { tenantId: f.tenantId, code: `TYP-${n}-${Math.random().toString(36).slice(2, 6)}`, name: `Type ${n}` },
      });
      const bom = await owner.bomItem.create({
        data: { jobId: f.job.id, equipmentId: f.equipment.id, itemNo: 100 + n, partName: `Part ${n}`, sourceQty: "1", componentTypeId: type.id },
      });
      return { type, bom };
    }
    async function route(typeId: number, familyId: number | null, variant: string, published: boolean, steps: Array<{ operationId: number; requiresQc?: boolean }>) {
      const r = await owner.routeTemplate.create({
        data: { tenantId: f.tenantId, componentTypeId: typeId, familyId, name: `R ${variant}`, variant },
      });
      const v = await owner.routeTemplateVersion.create({
        data: { routeId: r.id, version: 1, status: published ? "PUBLISHED" : "DRAFT" },
      });
      await owner.routeStep.createMany({
        data: steps.map((s, i) => ({ routeVersionId: v.id, seq: (i + 1) * 10, operationId: s.operationId, requiresQc: s.requiresQc ?? true })),
      });
      return { r, v };
    }
    const materialise = (bomItemId: number) =>
      withTenant(f.tenantId, (tx) => materializeComponentsFromBomItems(tx, f.family.id, f.equipment.id, [bomItemId], f.job.id));
    const componentFor = (bomItemId: number) =>
      owner.component.findFirstOrThrow({ where: { bomItemId }, include: { operations: { orderBy: { seq: "asc" } } } });

    it("picks the lowest variant letter, regardless of creation order", async () => {
      const { type, bom } = await newType();
      const b = await route(type.id, f.family.id, "B", true, [{ operationId: f.fitup.id }]);
      const a = await route(type.id, f.family.id, "A", true, [{ operationId: f.inspection.id }, { operationId: f.fitup.id }]);
      expect(b.v.id).not.toBe(a.v.id);
      await materialise(bom.id);
      const c = await componentFor(bom.id);
      expect(c.routeVersionId).toBe(a.v.id);
      expect(c.operations).toHaveLength(2);
    });

    it("falls to variant B when A has nothing published", async () => {
      const { type, bom } = await newType();
      await route(type.id, f.family.id, "A", false, [{ operationId: f.inspection.id }]);
      const b = await route(type.id, f.family.id, "B", true, [{ operationId: f.fitup.id }]);
      await materialise(bom.id);
      expect((await componentFor(bom.id)).routeVersionId).toBe(b.v.id);
    });

    it("a family-specific route still beats the generic one", async () => {
      const { type, bom } = await newType();
      await route(type.id, null, "A", true, [{ operationId: f.inspection.id }]);
      const specific = await route(type.id, f.family.id, "B", true, [{ operationId: f.fitup.id }]);
      await materialise(bom.id);
      expect((await componentFor(bom.id)).routeVersionId).toBe(specific.v.id);
    });

    it("materialises the operation's requiresQc AND the step's (table: step x operation)", async () => {
      await owner.operationRef.update({ where: { id: f.machining.id }, data: { requiresQc: false } });
      try {
        const { type, bom } = await newType();
        await route(type.id, f.family.id, "A", true, [
          { operationId: f.inspection.id, requiresQc: true }, //  step true,  op true  -> true
          { operationId: f.fitup.id, requiresQc: false }, //      step false, op true  -> false
          { operationId: f.machining.id, requiresQc: true }, //   step true,  op false -> false
          { operationId: f.machining.id, requiresQc: false }, //  step false, op false -> false
        ]);
        await materialise(bom.id);
        const c = await componentFor(bom.id);
        expect(c.operations.map((o) => o.requiresQc)).toEqual([true, false, false, false]);
      } finally {
        await owner.operationRef.update({ where: { id: f.machining.id }, data: { requiresQc: true } });
      }
    });
  });

  describe("createOrReviseRouteTemplate — variant", () => {
    const steps = () => [{ seq: 1, optional: false, operationId: f.inspection.id }];

    it("omitted variant is A; variant B is a separate route; revising B leaves A alone", async () => {
      const type = await owner.componentTypeRef.create({
        data: { tenantId: f.tenantId, code: `RV-${Math.random().toString(36).slice(2, 7)}`, name: "Route variant type" },
      });
      const base = { componentTypeId: type.id, familyId: f.family.id, steps: steps() };
      const a1 = await createOrReviseRouteTemplate(actorFor(), { ...base, name: "A route" });
      const b1 = await createOrReviseRouteTemplate(actorFor(), { ...base, name: "B route", variant: "B" });
      const b2 = await createOrReviseRouteTemplate(actorFor(), { ...base, name: "B route", variant: "B" });

      const routes = await owner.routeTemplate.findMany({
        where: { tenantId: f.tenantId, componentTypeId: type.id },
        orderBy: { variant: "asc" },
        include: { versions: true },
      });
      expect(routes.map((r) => [r.variant, r.versions.length])).toEqual([["A", 1], ["B", 2]]);
      expect(a1.routeId).not.toBe(b1.routeId);
      expect(b2.routeId).toBe(b1.routeId);
      expect(b2.version).toBe(2);
    });

    it("refuses a lowercase or multi-letter variant", async () => {
      for (const bad of ["a", "AB"]) {
        await expect(
          createOrReviseRouteTemplate(actorFor(), { componentTypeId: f.rawForm.id, familyId: f.family.id, name: "x", variant: bad, steps: steps() }),
        ).rejects.toThrow();
      }
    });
  });
});
