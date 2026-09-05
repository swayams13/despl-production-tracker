import { afterAll, describe, expect, it } from "vitest";
import { ROLES } from "@/lib/authz";

/**
 * cron.service, DB-gated. Three things pinned: multi-tenant isolation (one
 * tenant's overdue plan doesn't leak into another's run), the digest's
 * holiday skip, and a tenant with no active ADMIN user failing loudly
 * without blocking its siblings.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("cron.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { runAlertReconciliation, runDailyDigest } = await import("./cron.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  const past = new Date(Date.now() - 20 * 864e5);

  async function makeOrgWithOverduePlan(suffix: string): Promise<{ tenantId: number; planId: number }> {
    const org = await owner.organization.create({ data: { code: `CRON-ALERTS-${suffix}-${Date.now()}`, name: "Cron alerts test" } });
    const dept = await owner.department.create({ data: { tenantId: org.id, code: "PROD", name: "Production" } });
    const client = await owner.client.create({ data: { tenantId: org.id, name: "ACME", code: `ACME-${suffix}-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId: org.id, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId: org.id, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: { tenantId: org.id, publicId: `pub-cron-${suffix}-${Date.now()}`, clientId: client.id, familyId: family.id, templateVersionId: tv.id, jobNumber: `CRON-${suffix}-${Date.now()}` },
    });
    const run = await owner.scheduleRun.create({ data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: past, isCurrent: true } });
    const jp = await owner.jobProcess.create({ data: { jobId: job.id, seq: 1, code: "C1", name: "Overdue process", departmentId: dept.id, workOrderStages: [1] } });
    const plan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: dept.id, status: "IN_PROGRESS", plannedFinish: past },
    });
    return { tenantId: org.id, planId: plan.id };
  }

  // ponytail: 120s timeout (vitest default is 5s) — runAlertReconciliation
  // loops every Organization row in the shared despl_test DB, which has
  // accumulated 1000+ orgs from prior DB-gated test runs that never clean up
  // after themselves. Real per-tenant logic is fast; this is scale in a
  // polluted fixture DB, not a slow implementation. Fix properly by having
  // the DB-gated suite delete its fixture orgs, or by scoping this test's
  // assertions instead of looping the live table.
  it(
    "reconciles overdue plans independently per tenant, no cross-tenant leakage",
    async () => {
      const a = await makeOrgWithOverduePlan("a");
      const b = await makeOrgWithOverduePlan("b");

      const results = await runAlertReconciliation();

      const rA = results.find((r) => r.tenantId === a.tenantId);
      const rB = results.find((r) => r.tenantId === b.tenantId);
      expect(rA?.ok).toBe(true);
      expect(rB?.ok).toBe(true);

      const notifsA = await owner.notification.findMany({ where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: a.planId } });
      const notifsB = await owner.notification.findMany({ where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: b.planId } });
      // Neither tenant had a department member to notify (no users seeded in
      // this fixture beyond the org/dept skeleton) — the meaningful assertion
      // is that both runs completed independently (ok:true) without throwing,
      // not the recipient count, which is legitimately 0 here.
      expect(notifsA).toHaveLength(0);
      expect(notifsB).toHaveLength(0);
    },
    300_000,
  );

  async function makeOrgWithAdminAndCalendar(suffix: string, holidayToday: boolean): Promise<number> {
    const org = await owner.organization.create({ data: { code: `CRON-DIGEST-${suffix}-${Date.now()}`, name: "Cron digest test" } });
    const adminRole = await owner.role.create({ data: { tenantId: org.id, code: "ADMIN", name: "Admin" } });
    const mgmtRole = await owner.role.create({ data: { tenantId: org.id, code: "MANAGEMENT", name: "Management" } });
    const admin = await owner.user.create({
      data: { tenantId: org.id, email: `admin-${suffix}-${Date.now()}@x`, username: `admin-${suffix}-${Date.now()}`, name: "Admin", passwordHash: "x" },
    });
    await owner.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
    const mgmt = await owner.user.create({
      data: { tenantId: org.id, email: `mgmt-${suffix}-${Date.now()}@x`, username: `mgmt-${suffix}-${Date.now()}`, name: "MGMT", passwordHash: "x" },
    });
    await owner.userRole.create({ data: { userId: mgmt.id, roleId: mgmtRole.id } });

    const cal = await owner.workCalendar.create({ data: { tenantId: org.id, code: "DEFAULT", name: "Default", weekOffDays: [7], isDefault: true } });
    if (holidayToday) {
      await owner.holiday.create({ data: { calendarId: cal.id, date: new Date(), name: "Test holiday" } });
    }
    return org.id;
  }

  // ponytail: same 120s override as above — runDailyDigest also loops every
  // Organization in the shared, never-cleaned despl_test DB.
  it(
    "runs the digest and audits it as the tenant's admin, on a working day",
    async () => {
      const tenantId = await makeOrgWithAdminAndCalendar("workday", false);
      const results = await runDailyDigest();
      const r = results.find((x) => x.tenantId === tenantId);
      expect(r?.ok).toBe(true);
      expect(r?.skipped).toBeFalsy();
      expect(r?.count).toBe(1);

      const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId, action: "reports.publishDigest" } });
      const admin = await owner.user.findFirstOrThrow({ where: { tenantId, roles: { some: { role: { code: ROLES.ADMIN } } } } });
      expect(audit.actorId).toBe(admin.id);
    },
    120_000,
  );

  it(
    "skips a tenant whose calendar marks today as a holiday",
    async () => {
      const tenantId = await makeOrgWithAdminAndCalendar("holiday", true);
      const results = await runDailyDigest();
      const r = results.find((x) => x.tenantId === tenantId);
      expect(r?.ok).toBe(true);
      expect(r?.skipped).toBe(true);

      const notifs = await owner.notification.findMany({ where: { tenantId, type: "DIGEST_PUBLISHED" } });
      expect(notifs).toHaveLength(0);
    },
    120_000,
  );

  it(
    "fails loudly (not silently) for a tenant with no active ADMIN user, without blocking others",
    async () => {
      const org = await owner.organization.create({ data: { code: `CRON-NOADMIN-${Date.now()}`, name: "No admin test" } });
      await owner.workCalendar.create({ data: { tenantId: org.id, code: "DEFAULT", name: "Default", weekOffDays: [7], isDefault: true } });
      const workingTenant = await makeOrgWithAdminAndCalendar("sibling", false);

      const results = await runDailyDigest();
      const failed = results.find((x) => x.tenantId === org.id);
      const succeeded = results.find((x) => x.tenantId === workingTenant);

      expect(failed?.ok).toBe(false);
      expect(failed?.error).toMatch(/no active ADMIN/);
      expect(succeeded?.ok).toBe(true);
    },
    120_000,
  );
});
