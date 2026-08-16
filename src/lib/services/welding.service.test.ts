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
    return { userId: 1, tenantId, clientId: null, name: "Test", email: "t@x", roles: [], departmentIds: [], mustChangePassword: false };
  }

  async function fixture() {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    const unit = await owner.unit.findFirstOrThrow({ where: { equipment: { jobId: job.id } }, orderBy: { id: "asc" } });
    const fabDept = await owner.department.findFirstOrThrow({ where: { tenantId: job.tenantId, code: "FABRICATION" } });
    const qcDept = await owner.department.findFirstOrThrow({ where: { tenantId: job.tenantId, code: "QC" } });
    const welder = await owner.welder.findFirstOrThrow({ where: { tenantId: job.tenantId } });
    const testType = await owner.testTypeRef.findFirstOrThrow({ where: { tenantId: job.tenantId } });
    return { job, unit, fabDept, qcDept, welder, testType };
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
  });
});
