import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import { createOrReviseRouteTemplate, setOperationRefFamilySeq } from "./route.service";

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "Admin",
    email: "admin@despl.test",
    roles: [ROLES.ADMIN],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
    ...over,
  };
}

/**
 * Guard rails checked against the caller's own request/actor shape, before
 * any DB read — same split as admin.service.test.ts's "pure refusals" tier.
 */
describe("route.service — pure refusals", () => {
  it("createOrReviseRouteTemplate refuses a non-admin/production-head role", async () => {
    await expect(
      createOrReviseRouteTemplate(actor({ roles: [ROLES.SUPERVISOR] }), {
        componentTypeId: 1,
        familyId: null,
        name: "Shell route",
        steps: [{ seq: 1, optional: false, operationId: 1 }],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createOrReviseRouteTemplate refuses a client user, before the role check", async () => {
    await expect(
      createOrReviseRouteTemplate(actor({ clientId: 7, roles: [ROLES.ADMIN] }), {
        componentTypeId: 1,
        familyId: null,
        name: "Shell route",
        steps: [{ seq: 1, optional: false, operationId: 1 }],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createOrReviseRouteTemplate refuses two steps sharing the same seq, before touching the DB", async () => {
    await expect(
      createOrReviseRouteTemplate(actor(), {
        componentTypeId: 1,
        familyId: null,
        name: "Shell route",
        steps: [
          { seq: 1, optional: false, operationId: 1 },
          { seq: 1, optional: false, operationId: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
  });

  it("setOperationRefFamilySeq refuses a non-admin/production-head role", async () => {
    await expect(
      setOperationRefFamilySeq(actor({ roles: [ROLES.QC] }), {
        operationRefId: 1,
        familyId: 1,
        leadTimeProcessSeq: 5,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });
});

/**
 * DB-backed coverage, gated the same way as admin.service.test.ts's
 * "createUser (DB-backed)" block: RUN_DB_TESTS=1 + DIRECT_URL, disposable org.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("route.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let admin: Actor;
  let familyId: number;
  let componentTypeId: number;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-ROUTE-${Date.now()}`, name: "Route svc test" },
    });
    tenantId = org.id;
    const family = await owner.productFamily.create({
      data: { tenantId, code: "PRESSURE_VESSEL", name: "Pressure Vessel" },
    });
    familyId = family.id;
    const componentType = await owner.componentTypeRef.create({
      data: { tenantId, code: "SHELL", name: "Shell" },
    });
    componentTypeId = componentType.id;

    admin = {
      userId: 1,
      tenantId,
      clientId: null,
      name: "Test Admin",
      email: "admin@route-svc.test",
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("creates a fresh route with a new inline operation, reusable in a second route without duplicating the OperationRef", async () => {
    const v1 = await createOrReviseRouteTemplate(admin, {
      componentTypeId,
      familyId: null,
      name: "Shell standard route",
      printedRoute: "Cutting > Rolling",
      steps: [{ seq: 1, optional: false, newOperation: { code: "cutting", name: "Cutting" } }],
    });
    expect(v1.version).toBe(1);
    expect(v1.status).toBe("PUBLISHED");

    const cuttingOps = await owner.operationRef.findMany({ where: { tenantId, code: "CUTTING" } });
    expect(cuttingOps).toHaveLength(1);
    const cuttingId = cuttingOps[0].id;

    const secondComponentType = await owner.componentTypeRef.create({
      data: { tenantId, code: "NOZZLE", name: "Nozzle" },
    });
    await createOrReviseRouteTemplate(admin, {
      componentTypeId: secondComponentType.id,
      familyId: null,
      name: "Nozzle standard route",
      steps: [{ seq: 1, optional: false, newOperation: { code: "CUTTING", name: "Cutting" } }],
    });

    const stillOneCuttingOp = await owner.operationRef.findMany({ where: { tenantId, code: "CUTTING" } });
    expect(stillOneCuttingOp).toHaveLength(1);
    expect(stillOneCuttingOp[0].id).toBe(cuttingId);
  });

  it("revising a route creates a new PUBLISHED version while a Component pinned to the old version keeps its routeVersionId", async () => {
    const ct = await owner.componentTypeRef.create({ data: { tenantId, code: "HEAD", name: "Head" } });
    const v1 = await createOrReviseRouteTemplate(admin, {
      componentTypeId: ct.id,
      familyId: null,
      name: "Head standard route",
      steps: [{ seq: 1, optional: false, newOperation: { code: "FORMING", name: "Forming" } }],
    });

    const client = await owner.client.create({ data: { tenantId, name: "Client" } });
    const processTemplate = await owner.processTemplate.create({
      data: { tenantId, familyId, name: "PV Template" },
    });
    const processTemplateVersion = await owner.processTemplateVersion.create({
      data: { templateId: processTemplate.id, version: 1 },
    });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-route-${Date.now()}`,
        clientId: client.id,
        familyId,
        templateVersionId: processTemplateVersion.id,
        jobNumber: `JOB-ROUTE-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel" } });
    const component = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "HEAD-1", componentTypeId: ct.id, routeVersionId: v1.id },
    });

    const v2 = await createOrReviseRouteTemplate(admin, {
      componentTypeId: ct.id,
      familyId: null,
      name: "Head standard route",
      steps: [{ seq: 1, optional: false, newOperation: { code: "FORMING", name: "Forming" } }],
    });
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);

    const reloaded = await owner.component.findUniqueOrThrow({ where: { id: component.id } });
    expect(reloaded.routeVersionId).toBe(v1.id);
  });

  it("setOperationRefFamilySeq refuses ROUTE_STEP_SEQ_UNKNOWN, then succeeds and upserts for a number that is published", async () => {
    const dept = await owner.department.create({ data: { tenantId, code: "F", name: "Fabrication" } });
    const template = await owner.processTemplate.create({
      data: { tenantId, familyId, name: "PV template" },
    });
    const version = await owner.processTemplateVersion.create({
      data: { templateId: template.id, version: 1, status: "PUBLISHED" },
    });
    await owner.templateProcess.create({
      data: {
        versionId: version.id,
        seq: 1,
        code: "1",
        name: "Cutting",
        defaultDepartmentId: dept.id,
      },
    });

    const op = await owner.operationRef.create({ data: { tenantId, code: "SEQ-TEST-OP", name: "Test op" } });

    await expect(
      setOperationRefFamilySeq(admin, { operationRefId: op.id, familyId, leadTimeProcessSeq: 999 }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.ROUTE_STEP_SEQ_UNKNOWN);

    const created = await setOperationRefFamilySeq(admin, {
      operationRefId: op.id,
      familyId,
      leadTimeProcessSeq: 1,
    });
    expect(created.leadTimeProcessSeq).toBe(1);

    const updated = await setOperationRefFamilySeq(admin, {
      operationRefId: op.id,
      familyId,
      leadTimeProcessSeq: 1,
    });
    expect(updated.id).toBe(created.id);

    const rows = await owner.operationRefFamilySeq.findMany({ where: { operationRefId: op.id, familyId } });
    expect(rows).toHaveLength(1);
  });
});
