import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimPlan, assignPlan, releasePlan } from "./assignment.service";
import { ERROR_CODES } from "@/lib/shared/errors";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * Who a plan appears on whose list for (SPEC §5.1). D16: none of this reads
 * or influences process.service.ts's gating — these tests never import it.
 *
 * Pure refusals (client user, smuggled key) mirror delay.service.test.ts's
 * split: pure tier runs in CI, the full behavioural round-trip is DB-gated.
 */

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "Sup",
    email: "sup@despl.test",
    roles: [ROLES.SUPERVISOR],
    departmentIds: [3],
    mustChangePassword: false,
    ...over,
  };
}

describe("assignment service — pure refusals", () => {
  it("claimPlan refuses a client (read-only) user before touching the DB (invariant #8)", async () => {
    const clientUser = actor({ clientId: 99, roles: [ROLES.CLIENT_VIEWER], departmentIds: [] });
    await expect(claimPlan(clientUser, { processPlanId: 1 })).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  it("assignPlan refuses a client (read-only) user before touching the DB", async () => {
    const clientUser = actor({ clientId: 99, roles: [ROLES.CLIENT_VIEWER], departmentIds: [] });
    await expect(assignPlan(clientUser, { processPlanId: 1, userId: 2 })).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  it("assignPlan refuses a caller with none of SUPERVISOR/PRODUCTION_HEAD/ADMIN, before touching the DB", async () => {
    const qcOnly = actor({ roles: [ROLES.QC] });
    await expect(assignPlan(qcOnly, { processPlanId: 1, userId: 2 })).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  it("releasePlan refuses a client (read-only) user before touching the DB", async () => {
    const clientUser = actor({ clientId: 99, roles: [ROLES.CLIENT_VIEWER], departmentIds: [] });
    await expect(releasePlan(clientUser, { processPlanId: 1 })).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  it("rejects a smuggled *_at key on claimPlan via the strict schema (invariant #1)", async () => {
    await expect(
      // @ts-expect-error — .strict() schema; no timestamp field exists on this input
      claimPlan(actor(), { processPlanId: 1, claimedAt: new Date() }),
    ).rejects.toBeTruthy();
  });

  it("rejects a smuggled *_at key on assignPlan via the strict schema (invariant #1)", async () => {
    await expect(
      // @ts-expect-error — .strict() schema; no timestamp field exists on this input
      assignPlan(actor(), { processPlanId: 1, userId: 2, assignedAt: new Date() }),
    ).rejects.toBeTruthy();
  });

  it("rejects a smuggled *_at key on releasePlan via the strict schema (invariant #1)", async () => {
    await expect(
      // @ts-expect-error — .strict() schema; no timestamp field exists on this input
      releasePlan(actor(), { processPlanId: 1, releasedAt: new Date() }),
    ).rejects.toBeTruthy();
  });
});

/**
 * Behavioural round-trip against a live DB. Seeds one department's worth of
 * plans/users via the owner (DIRECT_URL, RLS-bypassing) client — same shape
 * as delay.service.test.ts's beforeAll — then drives the real service
 * functions (RLS-scoped inside withTenant). Gated off unless RUN_DB_TESTS=1
 * (pnpm test:db, against despl_test only).
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("assignment service — claim/assign/release (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let deptId = 0;
  let otherDeptId = 0;
  let runId = 0;

  let supervisor: Actor; // supervisor of deptId
  let outsideSupervisor: Actor; // supervisor of otherDeptId only
  let phActor: Actor; // PRODUCTION_HEAD, no department
  let adminActor: Actor; // ADMIN, no department
  let peerActor: Actor; // plain member of deptId (QC role, no supervisor/PH/admin)
  let deptMemberUserId = 0; // active user holding deptId — valid assign target
  let otherDeptUserId = 0; // active user holding otherDeptId only — invalid assign target
  let inactiveDeptMemberUserId = 0; // inactive user holding deptId

  async function makePlan(status: "NOT_STARTED" | "COMPLETE" = "NOT_STARTED") {
    const jp = await owner.jobProcess.create({
      data: {
        jobId: jobIdRef,
        seq: seqCounter++,
        code: String(seqCounter),
        name: "Test process",
        departmentId: deptId,
      },
    });
    return owner.processPlan.create({
      data: {
        scheduleRunId: runId,
        jobProcessId: jp.id,
        unitId: null,
        ownerDepartmentId: deptId,
        status,
      },
    });
  }

  let jobIdRef = 0;
  let seqCounter = 100;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `ASSIGN-${Date.now()}`, name: "Assignment svc test" },
    });
    tenantId = org.id;

    const dept = await owner.department.create({ data: { tenantId, code: "PROD", name: "Production" } });
    const otherDept = await owner.department.create({ data: { tenantId, code: "QA", name: "Quality" } });
    deptId = dept.id;
    otherDeptId = otherDept.id;

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-assign-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-ASSIGN-${Date.now()}`,
      },
    });
    jobIdRef = job.id;

    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    runId = run.id;

    const mkUser = async (suffix: string, opts: { active?: boolean; deptIds?: number[] } = {}) => {
      const u = await owner.user.create({
        data: {
          tenantId,
          email: `${suffix}-${Date.now()}@x`,
          username: `${suffix}-${Date.now()}`,
          name: suffix,
          passwordHash: "x",
          active: opts.active ?? true,
        },
      });
      for (const d of opts.deptIds ?? []) {
        await owner.userDepartment.create({ data: { userId: u.id, departmentId: d } });
      }
      return u;
    };

    const supUser = await mkUser("sup", { deptIds: [deptId] });
    const outsideSupUser = await mkUser("outsidesup", { deptIds: [otherDeptId] });
    const phUser = await mkUser("ph");
    const adminUser = await mkUser("admin");
    const peerUser = await mkUser("peer", { deptIds: [deptId] });
    const deptMember = await mkUser("member", { deptIds: [deptId] });
    const otherMember = await mkUser("othermember", { deptIds: [otherDeptId] });
    const inactiveMember = await mkUser("inactive", { active: false, deptIds: [deptId] });

    deptMemberUserId = deptMember.id;
    otherDeptUserId = otherMember.id;
    inactiveDeptMemberUserId = inactiveMember.id;

    const base = { tenantId, clientId: null, email: "x", name: "x", mustChangePassword: false };
    supervisor = { ...base, userId: supUser.id, roles: [ROLES.SUPERVISOR], departmentIds: [deptId] };
    outsideSupervisor = { ...base, userId: outsideSupUser.id, roles: [ROLES.SUPERVISOR], departmentIds: [otherDeptId] };
    phActor = { ...base, userId: phUser.id, roles: [ROLES.PRODUCTION_HEAD], departmentIds: [] };
    adminActor = { ...base, userId: adminUser.id, roles: [ROLES.ADMIN], departmentIds: [] };
    peerActor = { ...base, userId: peerUser.id, roles: [ROLES.QC], departmentIds: [deptId] };
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("claim succeeds into an unassigned dept-pool plan", async () => {
    const plan = await makePlan();
    const claimed = await claimPlan(peerActor, { processPlanId: plan.id });
    expect(claimed.assigneeUserId).toBe(peerActor.userId);
  });

  it("claim refused — NOT_IN_DEPARTMENT (actor outside the plan's department)", async () => {
    const plan = await makePlan();
    await expect(claimPlan(outsideSupervisor, { processPlanId: plan.id })).rejects.toMatchObject({
      code: ERROR_CODES.NOT_IN_DEPARTMENT,
    });
  });

  it("claim refused — ALREADY_ASSIGNED", async () => {
    const plan = await makePlan();
    await claimPlan(peerActor, { processPlanId: plan.id });
    await expect(claimPlan(supervisor, { processPlanId: plan.id })).rejects.toMatchObject({
      code: ERROR_CODES.ALREADY_ASSIGNED,
    });
  });

  it("claim refused — PLAN_COMPLETE", async () => {
    const plan = await makePlan("COMPLETE");
    await expect(claimPlan(peerActor, { processPlanId: plan.id })).rejects.toMatchObject({
      code: ERROR_CODES.PLAN_COMPLETE,
    });
  });

  it("assign succeeds — supervisor of the owning dept assigning to an active dept member", async () => {
    const plan = await makePlan();
    const assigned = await assignPlan(supervisor, { processPlanId: plan.id, userId: deptMemberUserId });
    expect(assigned.assigneeUserId).toBe(deptMemberUserId);
  });

  it("assign refused — ASSIGNEE_NOT_IN_DEPARTMENT (target holds a different department)", async () => {
    const plan = await makePlan();
    await expect(
      assignPlan(supervisor, { processPlanId: plan.id, userId: otherDeptUserId }),
    ).rejects.toMatchObject({ code: ERROR_CODES.ASSIGNEE_NOT_IN_DEPARTMENT });
  });

  it("assign refused — ASSIGNEE_INACTIVE", async () => {
    const plan = await makePlan();
    await expect(
      assignPlan(supervisor, { processPlanId: plan.id, userId: inactiveDeptMemberUserId }),
    ).rejects.toMatchObject({ code: ERROR_CODES.ASSIGNEE_INACTIVE });
  });

  it("assign refused — FORBIDDEN (a supervisor of a different department)", async () => {
    const plan = await makePlan();
    await expect(
      assignPlan(outsideSupervisor, { processPlanId: plan.id, userId: deptMemberUserId }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("assign refused — FORBIDDEN (a non-supervisor peer in the same department)", async () => {
    const plan = await makePlan();
    await expect(
      assignPlan(peerActor, { processPlanId: plan.id, userId: deptMemberUserId }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("assign succeeds for PRODUCTION_HEAD and ADMIN despite no department membership", async () => {
    const plan1 = await makePlan();
    const byPh = await assignPlan(phActor, { processPlanId: plan1.id, userId: deptMemberUserId });
    expect(byPh.assigneeUserId).toBe(deptMemberUserId);

    const plan2 = await makePlan();
    const byAdmin = await assignPlan(adminActor, { processPlanId: plan2.id, userId: deptMemberUserId });
    expect(byAdmin.assigneeUserId).toBe(deptMemberUserId);
  });

  it("reassign overwrites the existing assignee and writes a before → after audit row", async () => {
    const plan = await makePlan();
    await assignPlan(supervisor, { processPlanId: plan.id, userId: deptMemberUserId });

    const otherMember = await owner.user.create({
      data: { tenantId, email: `member2-${Date.now()}@x`, username: `member2-${Date.now()}`, name: "member2", passwordHash: "x" },
    });
    await owner.userDepartment.create({ data: { userId: otherMember.id, departmentId: deptId } });

    const reassigned = await assignPlan(supervisor, { processPlanId: plan.id, userId: otherMember.id });
    expect(reassigned.assigneeUserId).toBe(otherMember.id);

    const auditRow = await owner.auditLog.findFirst({
      where: { entityType: "ProcessPlan", entityId: String(plan.id), action: "assignment.assign" },
      orderBy: { id: "desc" },
    });
    expect(auditRow?.before).toMatchObject({ assigneeUserId: deptMemberUserId });
    expect(auditRow?.after).toMatchObject({ assigneeUserId: otherMember.id });
  });

  it("release by the assignee themselves succeeds and returns the plan to the pool", async () => {
    const plan = await makePlan();
    await claimPlan(peerActor, { processPlanId: plan.id });
    const released = await releasePlan(peerActor, { processPlanId: plan.id });
    expect(released.assigneeUserId).toBeNull();
  });

  it("release by the dept supervisor succeeds", async () => {
    const plan = await makePlan();
    await claimPlan(peerActor, { processPlanId: plan.id });
    const released = await releasePlan(supervisor, { processPlanId: plan.id });
    expect(released.assigneeUserId).toBeNull();
  });

  it("release refused — FORBIDDEN for a non-assignee, non-supervisor, non-PH/admin", async () => {
    const plan = await makePlan();
    await claimPlan(peerActor, { processPlanId: plan.id });
    await expect(releasePlan(outsideSupervisor, { processPlanId: plan.id })).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  /**
   * Final-review adjacent-minor: audit_log is append-only, so a
   * before === after === null row for a release that changed nothing is
   * permanent noise. Permission is still checked — only the write is skipped.
   */
  it("release of an already-unassigned plan is a no-op and writes NO audit row", async () => {
    const plan = await makePlan();
    const auditWhere = { entityType: "ProcessPlan", entityId: String(plan.id) };
    const before = await owner.auditLog.count({ where: auditWhere });

    const released = await releasePlan(supervisor, { processPlanId: plan.id });
    expect(released.assigneeUserId).toBeNull();
    expect(await owner.auditLog.count({ where: auditWhere })).toBe(before);
  });

  it("release of an already-unassigned plan is still FORBIDDEN for an outsider — the no-op short-circuit sits AFTER the permission gate", async () => {
    const plan = await makePlan();
    await expect(releasePlan(outsideSupervisor, { processPlanId: plan.id })).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  /**
   * Final-review Finding 3: `process_plans` is NOT covered by RLS (no tenantId
   * column, absent from tenant_tables), so lockProcessPlanForUpdate has to
   * anchor its read through the RLS-covered `departments` table itself. Before
   * the fix, a PH/ADMIN could null the assignee of ANY tenant's plan by id.
   * A cross-tenant id must read exactly like "doesn't exist".
   */
  describe("cross-tenant isolation (process_plans has no RLS of its own)", () => {
    let intruderPh: Actor;

    beforeAll(async () => {
      const otherOrg = await owner.organization.create({
        data: { code: `ASSIGN-XT-${Date.now()}`, name: "Other tenant" },
      });
      intruderPh = {
        userId: 999_999,
        tenantId: otherOrg.id,
        clientId: null,
        email: "intruder@other",
        name: "Intruder PH",
        roles: [ROLES.PRODUCTION_HEAD, ROLES.ADMIN],
        departmentIds: [],
        mustChangePassword: false,
      };
    });

    it("releasePlan — tenant B's PH/ADMIN gets NOT_FOUND for tenant A's plan, and the assignee survives", async () => {
      const plan = await makePlan();
      await claimPlan(peerActor, { processPlanId: plan.id });

      await expect(releasePlan(intruderPh, { processPlanId: plan.id })).rejects.toMatchObject({
        code: ERROR_CODES.NOT_FOUND,
      });

      const row = await owner.processPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect(row.assigneeUserId).toBe(peerActor.userId);
    });

    it("claimPlan and assignPlan are NOT_FOUND across tenants too", async () => {
      const plan = await makePlan();
      await expect(claimPlan(intruderPh, { processPlanId: plan.id })).rejects.toMatchObject({
        code: ERROR_CODES.NOT_FOUND,
      });
      await expect(
        assignPlan(intruderPh, { processPlanId: plan.id, userId: deptMemberUserId }),
      ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    });
  });
});
