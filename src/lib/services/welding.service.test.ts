import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * logWeldJoint/recordNdtResult (§9.8) have no pure logic worth isolating —
 * they're a department/role gate + a create, meaningful only against a real
 * seeded Job/Unit/Welder/TestTypeRef chain. DB-gated only, following
 * qcp.service.test.ts's DESPL-320 block.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("welding.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { logWeldJoint, recordNdtResult } = await import("./welding.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function actorBase(tenantId: number): Actor {
    return { userId: 1, tenantId, clientId: null, name: "Test", email: "t@x", roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  async function fixture() {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    const unit = await owner.unit.findFirstOrThrow({ where: { equipment: { jobId: job.id } }, orderBy: { id: "asc" } });
    const fabDept = await owner.department.findFirstOrThrow({ where: { tenantId: job.tenantId, code: "FABRICATION" } });
    const qcDept = await owner.department.findFirstOrThrow({ where: { tenantId: job.tenantId, code: "QC" } });
    const welder = await owner.welder.findFirstOrThrow({ where: { tenantId: job.tenantId } });
    const testType = await owner.testTypeRef.findFirstOrThrow({ where: { tenantId: job.tenantId } });
    const component = await owner.component.findFirstOrThrow({ where: { unitId: unit.id } });
    return { job, unit, fabDept, qcDept, welder, testType, component };
  }

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  it("logWeldJoint refuses a supervisor scoped to a different department (#8 RBAC deny-by-default)", async () => {
    const { job, unit, qcDept, welder } = await fixture();
    const outsider: Actor = { ...actorBase(job.tenantId), roles: [ROLES.SUPERVISOR], departmentIds: [qcDept.id] };
    await expectCode(
      logWeldJoint(outsider, { jobId: job.id, unitId: unit.id, jointNo: "T-1", jointType: "Test", welderIds: [welder.id] }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("logWeldJoint succeeds for the Fabrication supervisor and is attributed to the named welder(s)", async () => {
    const { job, unit, fabDept, welder } = await fixture();
    const supervisor: Actor = { ...actorBase(job.tenantId), roles: [ROLES.SUPERVISOR], departmentIds: [fabDept.id] };
    const joint = await logWeldJoint(supervisor, {
      jobId: job.id,
      unitId: unit.id,
      jointNo: `T-${Date.now()}`,
      jointType: "Test seam",
      welderIds: [welder.id],
    });
    expect(joint.jobId).toBe(job.id);
    const link = await owner.weldJointWelder.findUnique({ where: { weldJointId_welderId: { weldJointId: joint.id, welderId: welder.id } } });
    expect(link).not.toBeNull();
    // H1: createWeldJointTx populates jobId on every created WeldJointWelder.
    expect(link?.jobId).toBe(joint.jobId);
  });

  it("logWeldJoint persists and round-trips a valid componentId (A3)", async () => {
    const { job, unit, fabDept, welder, component } = await fixture();
    const supervisor: Actor = { ...actorBase(job.tenantId), roles: [ROLES.SUPERVISOR], departmentIds: [fabDept.id] };
    const joint = await logWeldJoint(supervisor, {
      jobId: job.id,
      unitId: unit.id,
      componentId: component.id,
      jointNo: `T-${Date.now()}`,
      jointType: "Test seam",
      welderIds: [welder.id],
    });
    expect(joint.componentId).toBe(component.id);
  });

  it("logWeldJoint refuses a componentId belonging to a different job (A3, NOT_FOUND)", async () => {
    const { job, unit, fabDept, welder } = await fixture();
    const otherOrg = await owner.organization.create({ data: { code: `TEST-WELD-XT-${Date.now()}`, name: "Other tenant" } });
    const otherFamily = await owner.productFamily.create({ data: { tenantId: otherOrg.id, code: "PRESSURE_VESSEL", name: "PV" } });
    const otherTemplate = await owner.processTemplate.create({ data: { tenantId: otherOrg.id, familyId: otherFamily.id, name: "PV" } });
    const otherVersion = await owner.processTemplateVersion.create({ data: { templateId: otherTemplate.id, version: 1 } });
    const otherClient = await owner.client.create({ data: { tenantId: otherOrg.id, name: "Other client" } });
    const otherJob = await owner.job.create({
      data: {
        tenantId: otherOrg.id,
        publicId: `pub-weld-xt-${Date.now()}`,
        clientId: otherClient.id,
        familyId: otherFamily.id,
        templateVersionId: otherVersion.id,
        jobNumber: `JOB-WELD-XT-${Date.now()}`,
      },
    });
    const otherEquipment = await owner.equipment.create({ data: { jobId: otherJob.id, name: "Other vessel" } });
    const otherType = await owner.componentTypeRef.create({ data: { tenantId: otherOrg.id, code: "PLATE", name: "Plate" } });
    const otherComponent = await owner.component.create({
      data: { equipmentId: otherEquipment.id, tag: "X1", componentTypeId: otherType.id },
    });

    const supervisor: Actor = { ...actorBase(job.tenantId), roles: [ROLES.SUPERVISOR], departmentIds: [fabDept.id] };
    await expectCode(
      logWeldJoint(supervisor, {
        jobId: job.id,
        unitId: unit.id,
        componentId: otherComponent.id,
        jointNo: `T-${Date.now()}`,
        jointType: "Test seam",
        welderIds: [welder.id],
      }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("logWeldJoint refuses a tenant with no WELDING OperationRef (B5: derived, not hardcoded, department)", async () => {
    const otherOrg = await owner.organization.create({ data: { code: `TEST-WELD-NOOP-${Date.now()}`, name: "No welding op tenant" } });
    const actor: Actor = { ...actorBase(otherOrg.id), roles: [ROLES.SUPERVISOR], departmentIds: [] };
    await expectCode(
      logWeldJoint(actor, { jobId: 1, jointNo: "T-3", jointType: "Test", welderIds: [1] }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("logWeldJoint refuses a client user — read-only, no exceptions", async () => {
    const { job, unit, fabDept, welder } = await fixture();
    const clientActor: Actor = { ...actorBase(job.tenantId), clientId: 1, roles: [ROLES.SUPERVISOR], departmentIds: [fabDept.id] };
    await expectCode(
      logWeldJoint(clientActor, { jobId: job.id, unitId: unit.id, jointNo: "T-2", jointType: "Test", welderIds: [welder.id] }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("recordNdtResult refuses a non-QC actor (e.g. SUPERVISOR) — recording a result is a QC act", async () => {
    const { job, unit, fabDept, welder, testType } = await fixture();
    const supervisor: Actor = { ...actorBase(job.tenantId), roles: [ROLES.SUPERVISOR], departmentIds: [fabDept.id] };
    const joint = await logWeldJoint(supervisor, {
      jobId: job.id,
      unitId: unit.id,
      jointNo: `T-${Date.now()}`,
      jointType: "Test seam",
      welderIds: [welder.id],
    });
    await expectCode(
      recordNdtResult(supervisor, { weldJointId: joint.id, testTypeId: testType.id, result: "ACCEPT" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("recordNdtResult succeeds for QC and records the server clock (invariant #1)", async () => {
    const { job, unit, fabDept, welder, testType } = await fixture();
    const supervisor: Actor = { ...actorBase(job.tenantId), roles: [ROLES.SUPERVISOR], departmentIds: [fabDept.id] };
    const qc: Actor = { ...actorBase(job.tenantId), roles: [ROLES.QC] };
    const joint = await logWeldJoint(supervisor, {
      jobId: job.id,
      unitId: unit.id,
      jointNo: `T-${Date.now()}`,
      jointType: "Test seam",
      welderIds: [welder.id],
    });
    const before = Date.now();
    const ndt = await recordNdtResult(qc, { weldJointId: joint.id, testTypeId: testType.id, result: "REJECT" });
    expect(ndt.result).toBe("REJECT");
    expect(ndt.recordedAt).not.toBeNull();
    expect(ndt.recordedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // H1: recordNdtResultTx populates jobId from the joint's own jobId.
    expect(ndt.jobId).toBe(joint.jobId);
  });
});
