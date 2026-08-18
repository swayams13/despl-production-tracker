import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * Task 4.2 (SPEC §7.3) — DB-backed coverage for `loadAdminView`'s Employees
 * table extensions: username/employeeCode passthrough, lastLogin (null vs
 * stamped), and the assigned-open-items count. Same disposable-org pattern
 * as assignment.service.test.ts; gated behind RUN_DB_TESTS (pnpm test:db).
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("admin.read — Employees table extensions (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadAdminView } = await import("./admin.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let admin: Actor;
  let userANoLoginId = 0; // never logged in
  let userBLoggedInId = 0;
  let userBLoggedInAt: Date;
  let userCOpenItemsId = 0; // 1 NOT_STARTED + 1 COMPLETE assigned -> openItemsCount 1
  let userDNoItemsId = 0; // no plans assigned -> openItemsCount 0

  afterAll(async () => {
    await owner.$disconnect();
  });

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `TEST-ADMINREAD-${Date.now()}`, name: "admin.read test" } });
    tenantId = org.id;
    await owner.role.create({ data: { tenantId, code: "ADMIN", name: "Admin" } });
    const dept = await owner.department.create({ data: { tenantId, code: "PROD", name: "Production" } });

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-adminread-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-ADMINREAD-${Date.now()}`,
      },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });

    let seq = 100;
    const mkPlan = async (assigneeUserId: number | null, status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE") => {
      const jp = await owner.jobProcess.create({
        data: { jobId: job.id, seq: seq++, code: String(seq), name: "Test process", departmentId: dept.id },
      });
      return owner.processPlan.create({
        data: { scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: dept.id, status, assigneeUserId },
      });
    };

    const mkUser = async (suffix: string) =>
      owner.user.create({
        data: { tenantId, email: `${suffix}-${Date.now()}@x`, username: `${suffix}-${Date.now()}`, name: suffix, passwordHash: "x", employeeCode: `EMP-${suffix}-${Date.now()}` },
      });

    const userA = await mkUser("nologin");
    const userB = await mkUser("loggedin");
    const userC = await mkUser("openitems");
    const userD = await mkUser("noitems");
    userANoLoginId = userA.id;
    userBLoggedInId = userB.id;
    userCOpenItemsId = userC.id;
    userDNoItemsId = userD.id;

    userBLoggedInAt = new Date("2026-08-16T10:30:00.000Z");
    await owner.user.update({ where: { id: userB.id }, data: { lastLoginAt: userBLoggedInAt } });

    await mkPlan(userC.id, "NOT_STARTED");
    await mkPlan(userC.id, "COMPLETE"); // must NOT count toward openItemsCount
    await mkPlan(null, "NOT_STARTED"); // unassigned pool item — must not count toward anyone

    // Task review round 1, Finding 2: a reschedule never deletes the prior
    // run's ProcessPlan rows (invariant #6). Give userD (otherwise 0 open
    // items) a NOT_STARTED plan on a SUPERSEDED run — without the
    // scheduleRun.isCurrent filter this leaks into their count.
    const staleRun = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 2, mode: "FORWARD", projectStartDate: new Date(), isCurrent: false },
    });
    const staleJp = await owner.jobProcess.create({
      data: { jobId: job.id, seq: seq++, code: String(seq), name: "Stale-run process", departmentId: dept.id },
    });
    await owner.processPlan.create({
      data: { scheduleRunId: staleRun.id, jobProcessId: staleJp.id, unitId: null, ownerDepartmentId: dept.id, status: "NOT_STARTED", assigneeUserId: userD.id },
    });

    admin = {
      userId: 1,
      tenantId,
      clientId: null,
      name: "Test Admin",
      email: "admin@test.local",
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  });

  it("carries username and employeeCode through to AdminUserRow", async () => {
    const view = await loadAdminView(admin);
    const row = view.users.find((u) => u.id === userCOpenItemsId);
    expect(row).toBeDefined();
    expect(row!.username).toContain("openitems");
    expect(row!.employeeCode).toContain("EMP-openitems");
  });

  it("lastLogin is null for a user who has never logged in", async () => {
    const view = await loadAdminView(admin);
    const row = view.users.find((u) => u.id === userANoLoginId);
    expect(row!.lastLogin).toBeNull();
  });

  it("lastLogin reflects a stamped login time as an ISO string", async () => {
    const view = await loadAdminView(admin);
    const row = view.users.find((u) => u.id === userBLoggedInId);
    expect(row!.lastLogin).toBe(userBLoggedInAt.toISOString());
  });

  it("openItemsCount counts non-COMPLETE assigned plans only, excludes COMPLETE and the unassigned pool item", async () => {
    const view = await loadAdminView(admin);
    const rowC = view.users.find((u) => u.id === userCOpenItemsId);
    expect(rowC!.openItemsCount).toBe(1);
  });

  it("openItemsCount excludes plans on a superseded (non-current) schedule run", async () => {
    // userD has a NOT_STARTED plan, but only on the stale run created above —
    // must still read 0, not 1.
    const view = await loadAdminView(admin);
    const rowD = view.users.find((u) => u.id === userDNoItemsId);
    expect(rowD!.openItemsCount).toBe(0);
  });

  it("departmentIds is populated for prefilling the edit dialog", async () => {
    const view = await loadAdminView(admin);
    // none of the fixture users hold a department; assert the field exists
    // and is an array (shape check — the join itself is exercised by
    // assignment.service.test.ts's dept-scoped fixtures).
    for (const u of view.users) {
      expect(Array.isArray(u.departmentIds)).toBe(true);
    }
  });
});
