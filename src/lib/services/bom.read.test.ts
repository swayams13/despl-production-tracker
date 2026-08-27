import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { formatBomQty } from "./bom.read";

/** Pure — no DB. B1's quantity cell: parsed `qtyPer`/`uom` renders numeric, an
 * unparsed row falls back to the raw `sourceQty` string and never throws. */
describe("formatBomQty", () => {
  it("renders qtyPer + uom when parsed", () => {
    expect(formatBomQty({ qtyPer: 40, uom: "NOS.", sourceQty: "40 NOS." })).toBe("40 NOS.");
  });

  it("renders a bare qtyPer when there's no uom", () => {
    expect(formatBomQty({ qtyPer: 24, uom: null, sourceQty: "24" })).toBe("24");
  });

  it("falls back to the raw sourceQty when unparsed, without throwing", () => {
    expect(formatBomQty({ qtyPer: null, uom: null, sourceQty: "As required" })).toBe("As required");
  });
});

/**
 * DB-backed coverage for `loadBomTree`'s component-route projection: a
 * component's process spine must show its FULL planned route (via
 * `RouteStep`, merged against actual `ComponentOperation` progress), not
 * just steps that have already started — and a step must surface the QCP
 * checkpoints gated to it (via `OperationRef.leadTimeProcessSeq` →
 * `JobProcess.code` → `QcpItemProcess` → `QcpItem`). Same disposable-org
 * pattern as admin.read.test.ts; gated behind RUN_DB_TESTS (pnpm test:db).
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("bom.read — component route projection (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadBomTree } = await import("./bom.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let actor: Actor;
  let jobId = 0;
  let unit1Id = 0;
  let unit2Id = 0;

  afterAll(async () => {
    await owner.$disconnect();
  });

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `TEST-BOMREAD-${Date.now()}`, name: "bom.read test" } });
    tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-bomread-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-BOMREAD-${Date.now()}`,
      },
    });
    jobId = job.id;

    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const cutting = await owner.operationRef.create({ data: { tenantId, code: "CUTTING", name: "Cutting", leadTimeProcessSeq: 12 } });
    const forming = await owner.operationRef.create({ data: { tenantId, code: "FORMING", name: "Forming", leadTimeProcessSeq: 13 } });
    const welding = await owner.operationRef.create({ data: { tenantId, code: "WELDING", name: "Welding", leadTimeProcessSeq: 16 } });

    const routeTemplate = await owner.routeTemplate.create({ data: { tenantId, componentTypeId: componentType.id, name: "Plate route" } });
    const routeVersion = await owner.routeTemplateVersion.create({ data: { routeId: routeTemplate.id, version: 1 } });
    await owner.routeStep.createMany({
      data: [
        { routeVersionId: routeVersion.id, seq: 1, operationId: cutting.id },
        { routeVersionId: routeVersion.id, seq: 2, operationId: forming.id },
        { routeVersionId: routeVersion.id, seq: 3, operationId: welding.id },
      ],
    });

    const equipment = await owner.equipment.create({ data: { jobId, name: "Air Receiver", blockNo: 1 } });
    const bomItem = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 1, partName: "Shell Course 1", sourceQty: "1", componentTypeId: componentType.id },
    });
    const component = await owner.component.create({
      data: { equipmentId: equipment.id, bomItemId: bomItem.id, tag: "SHELL-1", componentTypeId: componentType.id, routeVersionId: routeVersion.id },
    });
    // Only the first route step has actually been tracked — Forming/Welding
    // have no ComponentOperation row yet, same as real live-CSV data where
    // future steps were never recorded.
    await owner.componentOperation.create({
      data: { componentId: component.id, seq: 1, operationId: cutting.id, status: "COMPLETE" },
    });

    const jobProcess = await owner.jobProcess.create({
      data: { jobId, seq: 16, code: "16", name: "Welding", departmentId: dept.id },
    });
    const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId, jobLabel: "Test QAP", vessel: "Air Receiver" } });
    const qcpItem = await owner.qcpItem.create({
      data: { qcpTemplateId: qcpTemplate.id, sequence: 1, srNo: "1.1", kind: "CHECKPOINT", activity: "Visual weld inspection" },
    });
    await owner.qcpItemProcess.create({ data: { qcpItemId: qcpItem.id, jobProcessId: jobProcess.id } });

    // Two units with their own bomless (bomItemId: null) components — the
    // fanned-out-per-serial shape any job's sub-assembly register can take
    // once it has no BOM export yet (F2); generic fixture, not DESPL-320-specific.
    const unit1 = await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "UNIT-1" } });
    const unit2 = await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "UNIT-2" } });
    unit1Id = unit1.id;
    unit2Id = unit2.id;
    await owner.component.create({
      data: { equipmentId: equipment.id, unitId: unit1.id, tag: "PART-A", componentTypeId: componentType.id },
    });
    await owner.component.create({
      data: { equipmentId: equipment.id, unitId: unit2.id, tag: "PART-A", componentTypeId: componentType.id },
    });

    actor = {
      userId: 1,
      tenantId,
      clientId: null,
      name: "Test Actor",
      email: "actor@test.local",
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  });

  it("shows the full planned route, not just steps already started", async () => {
    const tree = await loadBomTree(actor, jobId);
    const ops = tree!.groups[0].items[0].components[0].operations;
    expect(ops.map((o) => o.operationName)).toEqual(["Cutting", "Forming", "Welding"]);
    expect(ops.map((o) => o.status)).toEqual(["COMPLETE", "NOT_STARTED", "NOT_STARTED"]);
  });

  it("attaches QCP checkpoints gated to a route step via leadTimeProcessSeq", async () => {
    const tree = await loadBomTree(actor, jobId);
    const ops = tree!.groups[0].items[0].components[0].operations;
    const welding = ops.find((o) => o.operationName === "Welding")!;
    expect(welding.qcpCheckpoints).toEqual([{ qcpItemId: expect.any(Number), srNo: "1.1", activity: "Visual weld inspection" }]);
  });

  it("leaves steps with no linked checkpoints empty, not omitted", async () => {
    const tree = await loadBomTree(actor, jobId);
    const ops = tree!.groups[0].items[0].components[0].operations;
    const cutting = ops.find((o) => o.operationName === "Cutting")!;
    expect(cutting.qcpCheckpoints).toEqual([]);
  });

  it("scopes bomless sub-assembly components to one unit, not all units flattened (F2)", async () => {
    const tree1 = await loadBomTree(actor, jobId, undefined, unit1Id);
    expect(tree1!.subAssemblyComponents).toHaveLength(1);
    expect(tree1!.unitId).toBe(unit1Id);

    const tree2 = await loadBomTree(actor, jobId, undefined, unit2Id);
    expect(tree2!.subAssemblyComponents).toHaveLength(1);
    expect(tree2!.unitId).toBe(unit2Id);

    expect(tree1!.units.map((u) => u.serialNo)).toEqual(["UNIT-1", "UNIT-2"]);
  });

  it("defaults to the first unit (by serialNo) when no unitId is given", async () => {
    const tree = await loadBomTree(actor, jobId);
    expect(tree!.unitId).toBe(unit1Id);
    expect(tree!.subAssemblyComponents).toHaveLength(1);
  });
});

/**
 * Schema-level coverage for B2's `BomItem.parentBomItemId` self-relation —
 * no service reads/writes it yet (first writer is the later, separately
 * dispatched BOM authoring UI). Just proves the FK and both relation
 * directions ("BomItemHierarchy") resolve via a direct Prisma call.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("BomItem.parentBomItemId (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("resolves parent -> children and child -> parent", async () => {
    const org = await owner.organization.create({ data: { code: `TEST-BOMPARENT-${Date.now()}`, name: "bom parent test" } });
    const client = await owner.client.create({ data: { tenantId: org.id, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId: org.id, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId: org.id, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId: org.id,
        publicId: `pub-bomparent-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-BOMPARENT-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver", blockNo: 1 } });
    const parent = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 1, partName: "Skirt Assembly", sourceQty: "1" },
    });
    const child = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 2, partName: "Gusset Plate", sourceQty: "24", parentBomItemId: parent.id },
    });

    const childWithParent = await owner.bomItem.findUniqueOrThrow({ where: { id: child.id }, include: { parent: true } });
    expect(childWithParent.parent?.id).toBe(parent.id);

    const parentWithChildren = await owner.bomItem.findUniqueOrThrow({ where: { id: parent.id }, include: { children: true } });
    expect(parentWithChildren.children.map((c) => c.id)).toEqual([child.id]);
  });
});
