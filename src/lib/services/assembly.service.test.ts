import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertAssemblyStepTransition, ASSEMBLY_STEP_TRANSITIONS, type AssemblyStepAction } from "./assembly.service";
import { assertMakerChecker, ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { OperationStatus } from "@/generated/prisma/client";

/**
 * Pure guard tests, mirroring component.service.test.ts's structure — the
 * transition matrix and maker–checker guard, no DB. Full locked-tx coverage
 * (department scope, sequential gate, joint binding, audit) lives in the
 * RUN_DB_TESTS block below.
 */

const ALL_STATUSES: OperationStatus[] = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "COMPLETE"];

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return isAppError(e) ? e.code : "NON_APP_ERROR";
  }
  return undefined;
}

describe("assertAssemblyStepTransition", () => {
  const legal: Array<[AssemblyStepAction, OperationStatus, OperationStatus]> = [
    ["start", "NOT_STARTED", "IN_PROGRESS"],
    ["submit", "IN_PROGRESS", "SUBMITTED"],
    ["verify", "SUBMITTED", "COMPLETE"],
    ["reject", "SUBMITTED", "IN_PROGRESS"],
  ];

  it.each(legal)("%s from %s → %s", (action, from, to) => {
    expect(assertAssemblyStepTransition(action, from)).toBe(to);
  });

  const legalSet = new Set(legal.map(([a, f]) => `${a}:${f}`));
  const actions = Object.keys(ASSEMBLY_STEP_TRANSITIONS) as AssemblyStepAction[];
  const illegal: Array<[AssemblyStepAction, OperationStatus]> = [];
  for (const a of actions) for (const f of ALL_STATUSES) if (!legalSet.has(`${a}:${f}`)) illegal.push([a, f]);

  it.each(illegal)("%s from %s → INVALID_STATE_TRANSITION", (action, from) => {
    expect(code(() => assertAssemblyStepTransition(action, from))).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
  });
});

describe("verify/reject maker–checker guard", () => {
  const qc = (userId: number): Actor => ({
    userId,
    tenantId: 1,
    clientId: null,
    name: "QC",
    email: "qc@x",
    roles: [ROLES.QC],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
  });
  const supervisorQc = (userId: number): Actor => ({ ...qc(userId), roles: [ROLES.SUPERVISOR, ROLES.QC] });

  const cases: Array<[string, Actor, number | null, string | undefined]> = [
    ["same human submitted and verifies/rejects → violation", supervisorQc(7), 7, ERROR_CODES.MAKER_CHECKER_VIOLATION],
    ["different QC user → allowed", qc(8), 7, undefined],
    ["no QC role → forbidden", { ...qc(8), roles: [ROLES.SUPERVISOR] }, 7, ERROR_CODES.FORBIDDEN],
    ["admin is not exempt (no QC role) → forbidden", { ...qc(9), roles: [ROLES.ADMIN] }, 7, ERROR_CODES.FORBIDDEN],
  ];

  it.each(cases)("%s", (_label, actor, submittedBy, expected) => {
    expect(code(() => assertMakerChecker(actor, submittedBy))).toBe(expected);
  });
});

/**
 * Full locked-transaction path against a live DB, same RUN_DB_TESTS gate and
 * disposable-org-per-run pattern as component.service.test.ts. Builds its
 * own throwaway AssemblyTemplate/Step/Unit fixture rather than DESPL-320's
 * seeded rows.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("assembly step state machine (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { startAssemblyStep, submitAssemblyStep, verifyAssemblyStep, rejectAssemblyStep } = await import(
    "./assembly.service"
  );
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let jobId = 0;
  let supA: Actor; // supervisor+QC in deptA (maker)
  let qc: Actor; // QC only, different user (checker)
  let supB: Actor; // supervisor in a DIFFERENT department (wrong-department attempt)
  let clientActor: Actor;
  let step1 = 0; // unit1, seq1 (deptA, no jointRef)
  let step2 = 0; // unit1, seq2 (deptA, jointRef "LS-1") — gated on step1
  let step3 = 0; // unit1, seq3 (deptB, no jointRef) — gated on step2
  let step4 = 0; // unit1, seq4 (deptB, INSPECTION, linked to qcpItemId) — A4 sync
  let step5 = 0; // unit1, seq5 (deptB, WORK, no qcpItemId) — A4 sync must not fire here
  let unit1Id = 0;
  let unit2Step1 = 0; // unit2, seq1 — cross-unit isolation
  let rejectCategoryId = 0;
  let testTypeId = 0;
  let qcpItemId = 0;

  async function auditCount(entityId: number): Promise<number> {
    return owner.auditLog.count({ where: { tenantId, entityType: "AssemblyStep", entityId: String(entityId) } });
  }

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `TEST-ASM-${Date.now()}`, name: "Assembly svc test" } });
    tenantId = org.id;

    const deptA = await owner.department.create({ data: { tenantId, code: "A", name: "Dept A" } });
    const deptB = await owner.department.create({ data: { tenantId, code: "B", name: "Dept B" } });
    const client = await owner.client.create({ data: { tenantId, name: "Client" } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV template" } });
    const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-asm-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-ASM-${Date.now()}`,
      },
    });
    jobId = job.id;
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel" } });
    const unit1 = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "01" } });
    const unit2 = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "02" } });

    const asmTemplate = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "A-Q" } });
    const asmVersion = await owner.assemblyTemplateVersion.create({
      data: { templateId: asmTemplate.id, version: 1, status: "PUBLISHED" },
    });
    const ts1 = await owner.assemblyTemplateStep.create({
      data: {
        versionId: asmVersion.id,
        seq: 1,
        groupCode: "C",
        groupName: "Shell Prep",
        srNo: "4.1",
        activity: "Transfer Of Marking And Cutting",
        kind: "WORK",
        defaultDepartmentId: deptA.id,
      },
    });
    const ts2 = await owner.assemblyTemplateStep.create({
      data: {
        versionId: asmVersion.id,
        seq: 2,
        groupCode: "E",
        groupName: "Shell Sub-Assembly (LS-1)",
        srNo: "4.5",
        activity: "Weld Long Seam Of Shell (LS-1)",
        kind: "WORK",
        defaultDepartmentId: deptA.id,
        jointRef: "LS-1",
      },
    });
    const ts3 = await owner.assemblyTemplateStep.create({
      data: {
        versionId: asmVersion.id,
        seq: 3,
        groupCode: "E",
        groupName: "Shell Sub-Assembly (LS-1)",
        srNo: "4.5",
        activity: "Weld Visual Of LS-1",
        kind: "INSPECTION",
        defaultDepartmentId: deptB.id,
      },
    });

    // A4: an INSPECTION step whose templateStep resolves to a real QcpItem —
    // the QCP checkpoint this step's verify/reject is supposed to record.
    const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId: job.id, jobLabel: "Vessel", vessel: "Vessel" } });
    const qcpItem = await owner.qcpItem.create({
      data: { qcpTemplateId: qcpTemplate.id, sequence: 1, srNo: "4.5", kind: "CHECKPOINT", activity: "Weld Visual Of LS-1" },
    });
    qcpItemId = qcpItem.id;
    const ts4 = await owner.assemblyTemplateStep.create({
      data: {
        versionId: asmVersion.id,
        seq: 4,
        groupCode: "E",
        groupName: "Shell Sub-Assembly (LS-1)",
        srNo: "4.5",
        activity: "Weld Visual Of LS-1",
        kind: "INSPECTION",
        defaultDepartmentId: deptB.id,
        qcpSrNo: "4.5",
      },
    });

    const ts5 = await owner.assemblyTemplateStep.create({
      data: {
        versionId: asmVersion.id,
        seq: 5,
        groupCode: "F",
        groupName: "Nozzle Sub-Assembly",
        srNo: "4.6",
        activity: "Nozzle To Flange/Elbow Set Up",
        kind: "WORK",
        defaultDepartmentId: deptB.id,
      },
    });

    step1 = (await owner.assemblyStep.create({ data: { unitId: unit1.id, templateStepId: ts1.id, seq: 1, jobId } })).id;
    step2 = (await owner.assemblyStep.create({ data: { unitId: unit1.id, templateStepId: ts2.id, seq: 2, jobId } })).id;
    step3 = (await owner.assemblyStep.create({ data: { unitId: unit1.id, templateStepId: ts3.id, seq: 3, jobId } })).id;
    step4 = (await owner.assemblyStep.create({ data: { unitId: unit1.id, templateStepId: ts4.id, seq: 4, qcpItemId, jobId } })).id;
    step5 = (await owner.assemblyStep.create({ data: { unitId: unit1.id, templateStepId: ts5.id, seq: 5, jobId } })).id;
    unit1Id = unit1.id;
    unit2Step1 = (await owner.assemblyStep.create({ data: { unitId: unit2.id, templateStepId: ts1.id, seq: 1, jobId } })).id;

    rejectCategoryId = (await owner.delayCategoryRef.create({ data: { tenantId, code: "REWORK", name: "Rework" } })).id;
    testTypeId = (await owner.testTypeRef.create({ data: { tenantId, code: "PAUT", name: "PAUT" } })).id;

    const userSup = await owner.user.create({
      data: { tenantId, email: "asm-sup@x", username: "asm-sup", name: "Sup", passwordHash: "x" },
    });
    const userQc = await owner.user.create({
      data: { tenantId, email: "asm-qc@x", username: "asm-qc", name: "Qc", passwordHash: "x" },
    });
    const userSupB = await owner.user.create({
      data: { tenantId, email: "asm-supb@x", username: "asm-supb", name: "SupB", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null, mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
    supA = { ...base, userId: userSup.id, name: "Sup", email: "asm-sup@x", roles: [ROLES.SUPERVISOR, ROLES.QC], departmentIds: [deptA.id] };
    qc = { ...base, userId: userQc.id, name: "Qc", email: "asm-qc@x", roles: [ROLES.QC], departmentIds: [deptB.id] };
    supB = { ...base, userId: userSupB.id, name: "SupB", email: "asm-supb@x", roles: [ROLES.SUPERVISOR], departmentIds: [deptB.id] };
    clientActor = { ...base, userId: userQc.id, clientId: 1, name: "Client", email: "asm-client@x", roles: [ROLES.QC], departmentIds: [] };
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  it("out-of-order start: seq 2 cannot start before seq 1 on the same unit", async () => {
    await expectCode(startAssemblyStep(supA, { assemblyStepId: step2 }), ERROR_CODES.GATING_BLOCKED);
  });

  it("wrong department: a supervisor outside the step's department cannot start it", async () => {
    await expectCode(startAssemblyStep(supB, { assemblyStepId: step1 }), ERROR_CODES.FORBIDDEN);
  });

  it("client user cannot start — read-only, no exceptions", async () => {
    await expectCode(startAssemblyStep(clientActor, { assemblyStepId: step1 }), ERROR_CODES.FORBIDDEN);
  });

  it("cross-unit isolation: unit1's own sequence never gates unit2", async () => {
    const started = await startAssemblyStep(supA, { assemblyStepId: unit2Step1 });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("happy path start → submit → verify (no jointRef), one audit row per mutation", async () => {
    const before = await auditCount(step1);

    const started = await startAssemblyStep(supA, { assemblyStepId: step1 });
    expect(started.status).toBe("IN_PROGRESS");
    expect(started.startedAt).toBeInstanceOf(Date);
    expect(await auditCount(step1)).toBe(before + 1);

    const submitted = await submitAssemblyStep(supA, { assemblyStepId: step1 });
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedBy).toBe(supA.userId);
    expect(await auditCount(step1)).toBe(before + 2);

    const verified = await verifyAssemblyStep(qc, { assemblyStepId: step1 });
    expect(verified.status).toBe("COMPLETE");
    expect(verified.finishedAt).toBeInstanceOf(Date);
    expect(verified.verifiedBy).toBe(qc.userId);
    expect(await auditCount(step1)).toBe(before + 3);
  });

  it("weld step with a jointRef refuses submit with neither an existing joint nor inline fields", async () => {
    await startAssemblyStep(supA, { assemblyStepId: step2 });
    await expectCode(submitAssemblyStep(supA, { assemblyStepId: step2 }), ERROR_CODES.VALIDATION_FAILED);
  });

  it("weld step with a jointRef accepts inline newJoint fields, creates the joint and binds it", async () => {
    const welder = await owner.welder.create({ data: { tenantId, name: "V. Yadav", employeeCode: `W-${Date.now()}` } });
    const submitted = await submitAssemblyStep(supA, {
      assemblyStepId: step2,
      newJoint: { jointNo: "LS-1", jointType: "Long Seam", welderIds: [welder.id] },
    });
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.weldJointId).not.toBeNull();

    const joint = await owner.weldJoint.findUniqueOrThrow({ where: { id: submitted.weldJointId! } });
    expect(joint.jointNo).toBe("LS-1");
  });

  it("maker–checker: the submitter cannot verify or reject their own submission", async () => {
    await expectCode(verifyAssemblyStep(supA, { assemblyStepId: step2 }), ERROR_CODES.MAKER_CHECKER_VIOLATION);
    await expectCode(
      rejectAssemblyStep(supA, { assemblyStepId: step2, categoryId: rejectCategoryId }),
      ERROR_CODES.MAKER_CHECKER_VIOLATION,
    );
  });

  it("QC reject on the joint-bound step returns it to IN_PROGRESS, clears submittedBy, retains the rejection, and records an NdtResult(REJECT) — this is what makes the reject show against the welder's repair rate", async () => {
    const rejected = await rejectAssemblyStep(qc, {
      assemblyStepId: step2,
      categoryId: rejectCategoryId,
      detail: "PAUT indication",
      testTypeId,
    });
    expect(rejected.status).toBe("IN_PROGRESS");
    expect(rejected.submittedBy).toBeNull();

    const rejections = await owner.assemblyStepRejection.findMany({ where: { assemblyStepId: step2 } });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ categoryId: rejectCategoryId, detail: "PAUT indication", rejectedBy: qc.userId });
    // H1: rejectAssemblyStep populates jobId on the rejection and the Ncr it opens.
    expect(rejections[0].jobId).toBe(jobId);

    const ndt = await owner.ndtResult.findMany({ where: { weldJointId: rejected.weldJointId! } });
    expect(ndt).toHaveLength(1);
    expect(ndt[0].result).toBe("REJECT");

    // N1 (Phase 5): reject opens exactly one Ncr, linked to that rejection.
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { assemblyStepRejectionId: rejections[0].id } });
    expect(ncr.status).toBe("OPEN");
    expect(ncr.jobId).toBe(jobId);

    // Rejected work restarts from the SAME step — must be resubmittable.
    const resubmitted = await submitAssemblyStep(supA, { assemblyStepId: step2 });
    expect(resubmitted.status).toBe("SUBMITTED");

    // Unblock step3 (seq 3, gated on step2 = seq 2) for the tests below.
    const verified = await verifyAssemblyStep(qc, { assemblyStepId: step2 });
    expect(verified.status).toBe("COMPLETE");

    // N1: re-verifying closes the open Ncr.
    const closed = await owner.ncr.findUniqueOrThrow({ where: { id: ncr.id } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedBy).toBe(qc.userId);
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it("reject with a testTypeId requires a bound weld joint — refused on a step with none", async () => {
    await startAssemblyStep(supB, { assemblyStepId: step3 });
    await submitAssemblyStep(supB, { assemblyStepId: step3 });
    await expectCode(
      rejectAssemblyStep(qc, { assemblyStepId: step3, categoryId: rejectCategoryId, testTypeId }),
      ERROR_CODES.VALIDATION_FAILED,
    );
  });

  it("N1 regression (task review Critical #1): reject → resubmit → reject again leaves TWO open Ncrs, and a single verify closes BOTH", async () => {
    // step3 is SUBMITTED (submittedBy = supB) — the prior test's reject attempt failed validation.
    await rejectAssemblyStep(qc, { assemblyStepId: step3, categoryId: rejectCategoryId, detail: "first reject" });
    await submitAssemblyStep(supB, { assemblyStepId: step3 });
    await rejectAssemblyStep(qc, { assemblyStepId: step3, categoryId: rejectCategoryId, detail: "second reject" });
    await submitAssemblyStep(supB, { assemblyStepId: step3 });

    const openBefore = await owner.ncr.findMany({
      where: { status: { not: "CLOSED" }, assemblyStepRejection: { assemblyStepId: step3 } },
    });
    expect(openBefore).toHaveLength(2);

    const verified = await verifyAssemblyStep(qc, { assemblyStepId: step3 });
    expect(verified.status).toBe("COMPLETE");

    const stillOpen = await owner.ncr.findMany({
      where: { status: { not: "CLOSED" }, assemblyStepRejection: { assemblyStepId: step3 } },
    });
    expect(stillOpen).toHaveLength(0);
    const nowClosed = await owner.ncr.findMany({ where: { id: { in: openBefore.map((n) => n.id) } } });
    expect(nowClosed.every((n) => n.status === "CLOSED")).toBe(true);
  });

  it("A4: reject then verify on an INSPECTION step linked to a real QcpItem records QcpExecution(REJECTED) then QcpExecution(ACCEPTED) as successive attempts — the assembly view and the QCP/hold-point view must agree", async () => {
    // step4 is gated on step3 (now COMPLETE from the test above).
    await startAssemblyStep(supB, { assemblyStepId: step4 });
    await submitAssemblyStep(supB, { assemblyStepId: step4 });

    const rejected = await rejectAssemblyStep(qc, { assemblyStepId: step4, categoryId: rejectCategoryId, detail: "recheck" });
    expect(rejected.status).toBe("IN_PROGRESS");

    const afterReject = await owner.qcpExecution.findMany({ where: { qcpItemId, unitId: unit1Id }, orderBy: { attemptNo: "asc" } });
    expect(afterReject).toHaveLength(1);
    expect(afterReject[0]).toMatchObject({ result: "REJECTED", clearedBy: qc.userId, attemptNo: 1 });

    await submitAssemblyStep(supB, { assemblyStepId: step4 });
    const verified = await verifyAssemblyStep(qc, { assemblyStepId: step4 });
    expect(verified.status).toBe("COMPLETE");

    const afterVerify = await owner.qcpExecution.findMany({ where: { qcpItemId, unitId: unit1Id }, orderBy: { attemptNo: "asc" } });
    expect(afterVerify).toHaveLength(2);
    expect(afterVerify[1]).toMatchObject({ result: "ACCEPTED", clearedBy: qc.userId, attemptNo: 2 });
  });

  it("A4: verifying a WORK-kind step (no qcpItemId) records no QcpExecution — the sync is scoped to INSPECTION steps only", async () => {
    // step5 is gated on step4 (now COMPLETE from the test above).
    await startAssemblyStep(supB, { assemblyStepId: step5 });
    await submitAssemblyStep(supB, { assemblyStepId: step5 });

    const before = await owner.qcpExecution.count({});
    const verified = await verifyAssemblyStep(qc, { assemblyStepId: step5 });
    expect(verified.status).toBe("COMPLETE");
    expect(await owner.qcpExecution.count({})).toBe(before);
  });

  it("illegal transition: verifying a NOT_STARTED step is refused", async () => {
    await expectCode(verifyAssemblyStep(qc, { assemblyStepId: unit2Step1 }), ERROR_CODES.INVALID_STATE_TRANSITION);
  });

  it("cross-tenant: another tenant's actor cannot reach this step by id (NOT_FOUND)", async () => {
    const otherOrg = await owner.organization.create({ data: { code: `TEST-ASM-XT-${Date.now()}`, name: "Other tenant" } });
    const intruder: Actor = {
      userId: 999_999,
      tenantId: otherOrg.id,
      clientId: null,
      name: "Intruder",
      email: "intruder@other",
      roles: [ROLES.SUPERVISOR, ROLES.QC],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    await expectCode(startAssemblyStep(intruder, { assemblyStepId: unit2Step1 }), ERROR_CODES.NOT_FOUND);
  });

  it("H1 job-level RLS backstop: verifyAssemblyStep's openNcrs lookup, scoped only by assemblyStepId (never jobId in the query itself), no longer reaches an Ncr row mistagged with a DIFFERENT job's jobId — the fix is app.job_id being set from the step's OWN jobId by lockAssemblyStepForUpdate, not an application-level filter", async () => {
    // Real reject → real AssemblyStepRejection → real (correctly job-scoped)
    // Ncr, exactly like rejectAssemblyStep's own code path. Then corrupt that
    // one row's jobId to a different, real job in the SAME tenant — not
    // reachable via any app write (same "not reachable via app writes"
    // convention as component.service.test.ts's kitCrossTenantOp/
    // kitCrossJobOp), simulating the exact "wrong job_id snuck onto a row"
    // class of bug this whole plan defends against. Before this task's fix,
    // verifyAssemblyStep's openNcrs findMany has no jobId in its where clause
    // at all — it would find and close this mistagged Ncr regardless. After
    // the fix, app.job_id is set to this step's own job for the rest of the
    // transaction, and job_isolation RLS (Task 4) makes the mistagged row
    // invisible to that same findMany — so it survives, unclosed.
    const otherJob = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-asm-rls-${Date.now()}`,
        clientId: (await owner.client.create({ data: { tenantId, name: "RLS Client" } })).id,
        familyId: (await owner.productFamily.findFirstOrThrow({ where: { tenantId } })).id,
        templateVersionId: (
          await owner.processTemplateVersion.findFirstOrThrow({ where: { template: { tenantId } } })
        ).id,
        jobNumber: `JOB-ASM-RLS-${Date.now()}`,
      },
    });

    const step1Row = await owner.assemblyStep.findUniqueOrThrow({ where: { id: step1 }, select: { unitId: true, templateStepId: true } });
    const rlsUnitEquipment = await owner.unit.findUniqueOrThrow({ where: { id: step1Row.unitId }, select: { equipmentId: true } });
    const rlsUnit = await owner.unit.create({ data: { jobId, equipmentId: rlsUnitEquipment.equipmentId, serialNo: "RLS-1" } });
    // Reuse step1's own templateStep (seq 1, deptA, no jointRef — no
    // previous-step gate, no joint-binding requirement) so this fixture
    // needs nothing beyond a fresh unit.
    const rlsStep = await owner.assemblyStep.create({
      data: { unitId: rlsUnit.id, templateStepId: step1Row.templateStepId, seq: 1, jobId },
    });

    await startAssemblyStep(supA, { assemblyStepId: rlsStep.id });
    await submitAssemblyStep(supA, { assemblyStepId: rlsStep.id });
    await rejectAssemblyStep(qc, { assemblyStepId: rlsStep.id, categoryId: rejectCategoryId });

    const rejection = await owner.assemblyStepRejection.findFirstOrThrow({ where: { assemblyStepId: rlsStep.id } });
    const ncr = await owner.ncr.findFirstOrThrow({ where: { assemblyStepRejectionId: rejection.id } });
    expect(ncr.status).not.toBe("CLOSED");
    // Corrupt: point this real Ncr at a DIFFERENT job in the same tenant.
    await owner.ncr.update({ where: { id: ncr.id }, data: { jobId: otherJob.id } });

    // reject already left the step IN_PROGRESS (its "to" state) — no second
    // start needed, just resubmit and verify.
    await submitAssemblyStep(supA, { assemblyStepId: rlsStep.id });
    await verifyAssemblyStep(qc, { assemblyStepId: rlsStep.id });

    const afterVerify = await owner.ncr.findUniqueOrThrow({ where: { id: ncr.id } });
    expect(afterVerify.status).not.toBe("CLOSED");
  });
});
