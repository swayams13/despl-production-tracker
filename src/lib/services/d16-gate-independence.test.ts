import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAppError, ERROR_CODES } from "@/lib/shared/errors";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * D16 (SPEC §10 / CLAUDE.md invariant #11's assignment corollary): assignment
 * never influences gating. assignment.service.ts and process.service.ts each
 * have their own isolated test suites that never import the other — by design
 * (see assignment.service.ts's own doc comment). That leaves exactly one gap
 * neither suite can close on its own: proving the two services compose
 * correctly, i.e. that claiming/assigning a plan does nothing to whether
 * startProcess's gate check lets it through. This file is the one place both
 * real services run together against real DB state.
 *
 * Fixture mirrors process.service.test.ts's DB-backed describe block (same
 * org/dept/job/jobProcess/edge/scheduleRun/plan shape) — jpB has a
 * FINISH_TO_START predecessor (jpA) that is never started, so planB stays
 * permanently gate-blocked for both tests below.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("D16 — assignment never bypasses gating (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { startProcess } = await import("./process.service");
  const { claimPlan, assignPlan } = await import("./assignment.service");
  // connection_limit is set once, for every DB-gated test file, on DIRECT_URL
  // itself in .env.test (this file and migration-backfill.test.ts originally
  // capped only their own pool here; moved to the single env-var source once
  // it turned out the app's own `prisma` singleton — fed by DATABASE_URL,
  // uncapped — was the bigger remaining contributor. See .env.test's comment).
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let deptId = 0;
  let planBId = 0; // gated via FINISH_TO_START on a predecessor plan left NOT_STARTED
  let planCId = 0; // second gated plan, for the claim test
  let assignee: Actor; // dept member the plan gets assigned to / who claims

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `D16-${Date.now()}`, name: "D16 gate-independence test" },
    });
    tenantId = org.id;

    const dept = await owner.department.create({ data: { tenantId, code: "D16", name: "D16 Dept" } });
    deptId = dept.id;

    const client = await owner.client.create({ data: { tenantId, name: "D16 Client" } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV template" } });
    const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-d16-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-D16-${Date.now()}`,
      },
    });

    const jpA = await owner.jobProcess.create({ data: { jobId: job.id, seq: 10, code: "10", name: "A", departmentId: deptId } });
    const jpB = await owner.jobProcess.create({ data: { jobId: job.id, seq: 20, code: "20", name: "B", departmentId: deptId } });
    const jpC = await owner.jobProcess.create({ data: { jobId: job.id, seq: 30, code: "30", name: "C", departmentId: deptId } });
    await owner.jobProcessEdge.create({ data: { processId: jpB.id, predecessorId: jpA.id, type: "FINISH_TO_START", lagDays: 0 } });
    await owner.jobProcessEdge.create({ data: { processId: jpC.id, predecessorId: jpA.id, type: "FINISH_TO_START", lagDays: 0 } });

    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, equipmentId: null, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    const future = new Date(Date.now() + 30 * 864e5);
    const mkPlan = (jobProcessId: number) =>
      owner.processPlan.create({
        data: {
          scheduleRunId: run.id,
          jobProcessId,
          unitId: null,
          ownerDepartmentId: deptId,
          plannedFinish: future,
          status: "NOT_STARTED",
        },
      });
    await mkPlan(jpA.id); // never started — keeps B and C gated
    planBId = (await mkPlan(jpB.id)).id;
    planCId = (await mkPlan(jpC.id)).id;

    const user = await owner.user.create({
      data: { tenantId, email: `d16-assignee-${Date.now()}@x`, username: `d16-assignee-${Date.now()}`, name: "Assignee", passwordHash: "x" },
    });
    await owner.userDepartment.create({ data: { userId: user.id, departmentId: deptId } });
    assignee = {
      userId: user.id,
      tenantId,
      clientId: null,
      name: "Assignee",
      email: "assignee@x",
      roles: [ROLES.SUPERVISOR],
      departmentIds: [deptId],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
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

  it("an assigned-but-gated plan still refuses start", async () => {
    const assigned = await assignPlan(assignee, { processPlanId: planBId, userId: assignee.userId });
    expect(assigned.assigneeUserId).toBe(assignee.userId);

    await expectCode(startProcess(assignee, { processPlanId: planBId }), ERROR_CODES.GATING_BLOCKED);

    // The gate refusal must not have reverted the assignment write.
    const after = await owner.processPlan.findUniqueOrThrow({ where: { id: planBId } });
    expect(after.assigneeUserId).toBe(assignee.userId);
    expect(after.status).toBe("NOT_STARTED");
  });

  it("an unassigned plan with open gates: claim succeeds, start still refuses the same as before", async () => {
    const before = await owner.processPlan.findUniqueOrThrow({ where: { id: planCId } });
    expect(before.assigneeUserId).toBeNull();

    const claimed = await claimPlan(assignee, { processPlanId: planCId });
    expect(claimed.assigneeUserId).toBe(assignee.userId);

    await expectCode(startProcess(assignee, { processPlanId: planCId }), ERROR_CODES.GATING_BLOCKED);

    const after = await owner.processPlan.findUniqueOrThrow({ where: { id: planCId } });
    expect(after.assigneeUserId).toBe(assignee.userId); // claim's write survived the gate refusal
    expect(after.status).toBe("NOT_STARTED");
  });
});
