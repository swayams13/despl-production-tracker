import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { isAppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * Negative cross-tenant suite (audit C3/H4, Phase 0 item 0.3).
 *
 * `rls-coverage.test.ts` only checks tables that already carry a `tenant_id`
 * column — it structurally cannot see a hole on a table that has none at all
 * (`qcp_items`, `qcp_executions`, `bom_items`, `weld_joints`, ~35 of 56
 * tables per the audit). This file closes the class those tables represent:
 * two real tenants, and every write/read entry point found taking one of
 * their un-RLS'd child-table ids as a raw argument must refuse the wrong
 * tenant's id, not silently act on it.
 *
 * // ponytail: hand-curated list of entry points, not a static-analysis sweep
 * of every function signature in lib/services/ — the four here are the ones
 * the audit named (C3's three, H4's one). Extend this file when the next one
 * is found; a generic "walk every exported service function" checker is the
 * upgrade path if the manual list stops scaling.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("cross-tenant write/read holes (DB, audit C3/H4)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { recordQcpExecution } = await import("./qcp.service");
  const { recordMtc } = await import("./mtc.service");
  const { nudgeQc } = await import("./notifications.service");
  const { loadWeldJointOptions } = await import("./welding.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function makeActor(tenantId: number, roles: string[]): Actor {
    return {
      userId: 1,
      tenantId,
      clientId: null,
      name: "Test Actor",
      email: `actor-${tenantId}@test.local`,
      roles: roles as never,
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  }

  /** Minimal tenant fixture: job → equipment → unit/bomItem/weldJoint, plus a
   * QcpItem and a ProcessPlan — the four rows each negative test below tries
   * to reach from the OTHER tenant. */
  async function makeTenant(label: string) {
    const org = await owner.organization.create({ data: { code: `TEST-XTENANT-${label}-${Date.now()}`, name: `cross-tenant test ${label}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${label}-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-xtenant-${label}-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-XTENANT-${label}-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unit = await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "01" } });
    const bomItem = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 1, partName: "Shell", sourceQty: "1" },
    });
    const weldJoint = await owner.weldJoint.create({
      data: { jobId: job.id, unitId: unit.id, jointNo: "LS-1", jointType: "LONG_SEAM", loggedBy: 1 },
    });
    const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId: job.id, jobLabel: "Test QAP", vessel: "Air Receiver" } });
    const qcpItem = await owner.qcpItem.create({
      data: { qcpTemplateId: qcpTemplate.id, sequence: 1, srNo: "1.1", kind: "CHECKPOINT", activity: "Visual weld inspection" },
    });
    const jobProcess = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 1, code: "1", name: "Receipt", departmentId: dept.id },
    });
    const scheduleRun = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date("2026-01-01"), isCurrent: true },
    });
    const processPlan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: scheduleRun.id, jobProcessId: jobProcess.id, ownerDepartmentId: dept.id, status: "NOT_STARTED" },
    });

    return { tenantId, jobId: job.id, unitId: unit.id, bomItemId: bomItem.id, weldJointId: weldJoint.id, qcpItemId: qcpItem.id, planId: processPlan.id };
  }

  let attacker: Awaited<ReturnType<typeof makeTenant>>;
  let victim: Awaited<ReturnType<typeof makeTenant>>;

  beforeAll(async () => {
    [attacker, victim] = await Promise.all([makeTenant("attacker"), makeTenant("victim")]);
  });

  it("recordQcpExecution refuses another tenant's unitId (audit C3)", async () => {
    const err = await recordQcpExecution(makeActor(attacker.tenantId, [ROLES.QC]), {
      qcpItemId: victim.qcpItemId,
      unitId: victim.unitId,
      result: "ACCEPTED",
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it("recordMtc refuses another tenant's bomItemId (audit C3)", async () => {
    const err = await recordMtc(makeActor(attacker.tenantId, [ROLES.QC]), {
      bomItemId: victim.bomItemId,
      heatNumber: "H-123",
      pmiResult: "ACCEPT",
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it("nudgeQc refuses another tenant's planId (audit C3)", async () => {
    const err = await nudgeQc(makeActor(attacker.tenantId, [ROLES.SUPERVISOR]), victim.planId, 3).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it("nudgeQc refuses a client-scoped actor regardless of tenant (audit C3)", async () => {
    const clientActor: Actor = { ...makeActor(victim.tenantId, [ROLES.SUPERVISOR]), clientId: 1 };
    const err = await nudgeQc(clientActor, victim.planId, 3).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it("loadWeldJointOptions never returns another tenant's joints (audit H4)", async () => {
    const options = await loadWeldJointOptions(makeActor(attacker.tenantId, [ROLES.SUPERVISOR]), victim.jobId);
    expect(options).toEqual([]);
  });
});
