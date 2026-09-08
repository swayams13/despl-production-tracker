import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { classifyDeptCode, resolveCommandCenterAccess, loadCommandCenter } from "./command-center.read";

/**
 * `/command/[dept]` (personal dashboards v1, SPEC §7.4, task 3.1).
 *
 * `classifyDeptCode`/`resolveCommandCenterAccess` are pulled out of
 * page.tsx as pure functions specifically so the routing + access-control
 * rules (task 3.1 rulings 1 and 3) are table-driven-testable without a
 * page-render harness, which this codebase doesn't have (CLAUDE.md: "any
 * change to ... RBAC ... requires table-driven tests for the violation
 * cases, not just happy paths").
 */

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "Test User",
    email: "t@despl.local",
    roles: [ROLES.SUPERVISOR],
    departmentIds: [10],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
    ...over,
  };
}

describe("classifyDeptCode — routing (ruling 1)", () => {
  // No department-code literals: classifyDeptCode takes the real row
  // (or null, for "no such department in this tenant") and decides purely
  // from its isOfficeDept flag — never a hardcoded office/floor code list.
  it("office department -> office", () => {
    expect(classifyDeptCode({ isOfficeDept: true })).toBe("office");
  });

  it("floor department -> floor", () => {
    expect(classifyDeptCode({ isOfficeDept: false })).toBe("floor");
  });

  it("no matching department in this tenant -> invalid", () => {
    expect(classifyDeptCode(null)).toBe("invalid");
  });
});

describe("resolveCommandCenterAccess — full / read-only / none (ruling 3)", () => {
  it("dept member gets full access", () => {
    expect(resolveCommandCenterAccess(actor({ departmentIds: [10] }), 10)).toBe("full");
  });

  it("non-member without PH/ADMIN/MANAGEMENT gets no access", () => {
    expect(resolveCommandCenterAccess(actor({ departmentIds: [11] }), 10)).toBe("none");
  });

  it.each([ROLES.PRODUCTION_HEAD, ROLES.ADMIN])("%s gets full access to any department, not just their own", (role) => {
    expect(resolveCommandCenterAccess(actor({ roles: [role], departmentIds: [] }), 10)).toBe("full");
  });

  it("MANAGEMENT gets read-only access, even outside their own department", () => {
    expect(resolveCommandCenterAccess(actor({ roles: [ROLES.MANAGEMENT], departmentIds: [] }), 10)).toBe("readonly");
  });

  it("a QC actor with no relevant role and no membership gets no access", () => {
    expect(resolveCommandCenterAccess(actor({ roles: [ROLES.QC], departmentIds: [99] }), 10)).toBe("none");
  });

  it("membership wins even without any special role", () => {
    expect(resolveCommandCenterAccess(actor({ roles: [], departmentIds: [10] }), 10)).toBe("full");
  });
});

/**
 * Cross-department "You're blocking" / "Waiting on others" (ruling 2f) —
 * fresh org/tenant fixture (same shape as myday.read.test.ts's own
 * beforeAll), minimal on purpose: one job, two office departments, one
 * FINISH_TO_START edge between them.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadCommandCenter — cross-department blocking (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("dept A's incomplete plan blocking dept B shows on A's 'You're blocking' and B's 'Waiting on others'", async () => {
    const org = await owner.organization.create({ data: { code: `CC-${Date.now()}`, name: "Command Center test" } });
    const tenantId = org.id;

    // STORES's process must complete before PROCUREMENT's can start —
    // real office-dept codes so PIPELINE_LABELS has an entry for each.
    const deptStores = await owner.department.create({ data: { tenantId, code: "STORES", name: "Stores" } });
    const deptProcurement = await owner.department.create({ data: { tenantId, code: "PROCUREMENT", name: "Procurement" } });

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-CC-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PV", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-cc-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-CC-${Date.now()}`,
        // status defaults to ACTIVE — loadCommandCenter only aggregates active jobs.
      },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });

    const jpStores = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 1, code: "P1", name: "Material receipt", departmentId: deptStores.id, durationMinDays: 1, durationMaxDays: 2 },
    });
    const jpProcurement = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 2, code: "P2", name: "PO placement", departmentId: deptProcurement.id, durationMinDays: 1, durationMaxDays: 2 },
    });
    await owner.jobProcessEdge.create({
      data: { jobId: job.id, processId: jpProcurement.id, predecessorId: jpStores.id, type: "FINISH_TO_START", lagDays: 0 },
    });

    // Stores' own process is not complete -> Procurement's plan is BLOCKED.
    await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpStores.id, ownerDepartmentId: deptStores.id, status: "NOT_STARTED" },
    });
    const blockedPlan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpProcurement.id, ownerDepartmentId: deptProcurement.id, status: "NOT_STARTED" },
    });

    const viewer: Actor = {
      userId: 1,
      tenantId,
      clientId: null,
      name: "PH",
      email: "ph@despl.test",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    const storesView = await loadCommandCenter(viewer, deptStores.id, "STORES", "Stores");
    expect(storesView.blocking.map((r) => r.ranked.plan.id)).toContain(blockedPlan.id);
    expect(storesView.waitingOnOthers.map((r) => r.ranked.plan.id)).not.toContain(blockedPlan.id);

    const procurementView = await loadCommandCenter(viewer, deptProcurement.id, "PROCUREMENT", "Procurement");
    expect(procurementView.waitingOnOthers.map((r) => r.ranked.plan.id)).toContain(blockedPlan.id);
    expect(procurementView.blocking.map((r) => r.ranked.plan.id)).not.toContain(blockedPlan.id);
    const row = procurementView.waitingOnOthers.find((r) => r.ranked.plan.id === blockedPlan.id)!;
    expect(row.ranked.reasonText).toContain("Material receipt");
  });

  it("team roster groups a department's open plans by assignee, overdue-first, and excludes unassigned/DONE plans (Phase 4)", async () => {
    const org = await owner.organization.create({ data: { code: `CC-TEAM-${Date.now()}`, name: "Command Center team test" } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "STORES", name: "Stores" } });

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-CC-TEAM-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PV", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-cc-team-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-CCTEAM-${Date.now()}`,
      },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    // ProcessPlan has a unique (scheduleRunId, jobProcessId) constraint — one
    // jobProcess per plan below, all job-grain (no unitId), matching how
    // office-department processes already work elsewhere in this file.
    const mkProcess = (seq: number, code: string) =>
      owner.jobProcess.create({
        data: { jobId: job.id, seq, code, name: "Material receipt", departmentId: dept.id, durationMinDays: 1, durationMaxDays: 2 },
      });
    const [jp1, jp2, jp3, jp4] = await Promise.all([mkProcess(1, "P1"), mkProcess(2, "P2"), mkProcess(3, "P3"), mkProcess(4, "P4")]);

    const member = await owner.user.create({
      data: { tenantId, email: `member-${Date.now()}@x`, username: `member-${Date.now()}`, name: "Roster Member", passwordHash: "x" },
    });
    const otherDeptMember = await owner.user.create({
      data: { tenantId, email: `other-${Date.now()}@x`, username: `other-${Date.now()}`, name: "Other Dept Member", passwordHash: "x" },
    });
    await owner.userDepartment.create({ data: { userId: member.id, departmentId: dept.id } });

    const overduePastDate = new Date(Date.now() - 5 * 864e5);
    // Assigned to a real roster member, overdue -> should show in their roster row.
    const overduePlan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp1.id, ownerDepartmentId: dept.id, status: "NOT_STARTED", assigneeUserId: member.id, plannedFinish: overduePastDate },
    });
    // Assigned to that same member but already COMPLETE -> excluded from the open-workload roster.
    await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp2.id, ownerDepartmentId: dept.id, status: "COMPLETE", assigneeUserId: member.id, actualStart: new Date(), actualFinish: new Date() },
    });
    // Unclaimed (no assignee) -> not attributed to any roster row.
    await owner.processPlan.create({ data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp3.id, ownerDepartmentId: dept.id, status: "NOT_STARTED" } });
    // Assigned to a user who is NOT a member of this department -> silently excluded from its roster.
    await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp4.id, ownerDepartmentId: dept.id, status: "NOT_STARTED", assigneeUserId: otherDeptMember.id },
    });

    const viewer: Actor = {
      userId: 1, tenantId, clientId: null, name: "PH", email: "ph@despl.test",
      roles: [ROLES.PRODUCTION_HEAD], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false,
    };
    const view = await loadCommandCenter(viewer, dept.id, "STORES", "Stores");

    expect(view.team.map((t) => t.userId)).toEqual([member.id]);
    const row = view.team[0];
    expect(row.name).toBe("Roster Member");
    expect(row.openCount).toBe(1);
    expect(row.overdueCount).toBe(1);
    expect(row.items.map((r) => r.ranked.plan.id)).toEqual([overduePlan.id]);
  });
});

describe.skipIf(!process.env.RUN_DB_TESTS)("loadCommandCenter — batched fan-out (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("rows are attributed to the correct job's own jobNumber for every active job", async () => {
    const jobs = await owner.job.findMany({ where: { status: "ACTIVE" } });
    if (jobs.length < 2) throw new Error("need >=2 ACTIVE jobs seeded to exercise the batch path meaningfully");
    const dept = await owner.department.findFirst({ where: { tenantId: jobs[0].tenantId, isOfficeDept: true } });
    if (!dept) throw new Error("seed missing an office department for the seeded tenant — run pnpm db:seed");

    const view = await loadCommandCenter(
      {
        userId: 1,
        tenantId: jobs[0].tenantId,
        clientId: null,
        name: "T",
        email: "t@despl.local",
        roles: [ROLES.PRODUCTION_HEAD],
        departmentIds: [],
        mustChangePassword: false,
        themePreference: "SYSTEM",
        outdoorMode: false,
      },
      dept.id,
      dept.code,
      dept.name,
    );

    const jobNumberById = new Map(jobs.map((j) => [j.id, j.jobNumber]));
    const allRows = [...view.decideToday, ...view.waitingOnOthers, ...view.blocking, ...view.pipeline.flatMap((c) => c.rows)];
    for (const row of allRows) {
      expect(row.jobNumber).toBe(jobNumberById.get(row.jobId));
    }
  });
});
