import { afterAll, describe, expect, it } from "vitest";

/**
 * Task 1.1's person-grain migration (prisma/migrations/20260816175249_person_grain)
 * does two DIFFERENT things per column and both need proving separately:
 *
 *   1. must_change_password: added nullable, EVERY existing row backfilled to
 *      false via a plain UPDATE, THEN the column got NOT NULL DEFAULT true.
 *      So existing (pre-migration) rows carry false from the backfill, while
 *      brand-new rows carry true from the default — two different mechanisms
 *      landing on two different values. A test against a fresh row only ever
 *      proves the default; it says nothing about whether the backfill UPDATE
 *      actually ran. This file checks both, separately.
 *   2. username: added nullable, backfilled via split_part(email, '@', 1) for
 *      existing rows, then made NOT NULL (no separate default — every row,
 *      old or new, gets an explicit username at insert time going forward).
 *
 * "Pre-existing seeded user" here means a user seeded by prisma/seed.ts (the
 * @despl.local domain, per its mkUser() calls) — never a user this file (or
 * any other DB-gated test) creates itself. Those seed rows were present in
 * despl_test BEFORE the migration ran, so their must_change_password value
 * can only be explained by the backfill, not the column default.
 *
 * CAVEAT — this proof depends on despl_test's history, not just its schema:
 * the seeded-user assertion below only works because despl_test has been
 * `migrate dev`'d incrementally and never reset, so it still carries @despl.local
 * rows that predate 20260816175249_person_grain. If despl_test is ever run
 * through `prisma migrate reset` and reseeded, `pnpm db:seed` will run AFTER
 * the column's `DEFAULT true` already exists in migration history — every
 * seeded row will land on `true`, and the first `it()` below will fail. That
 * failure means "the DB history this test relies on is gone," not "the
 * migration is broken" — there's no backfill left to prove on a
 * freshly-reset-then-reseeded table. Whoever hits it should delete/rewrite
 * this test at that point, or make it robust by cross-checking
 * `_prisma_migrations` timestamps against `user.createdAt` instead of
 * trusting live DB state.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Task 1.1 migration backfill (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  // ponytail: capped pool — see the matching comment in
  // d16-gate-independence.test.ts for why (this file is the other half of
  // the 2 new files that tipped the full DB suite into transient connection
  // timeouts on a second run).
  const owner = new PrismaClient({ datasourceUrl: `${process.env.DIRECT_URL}?connection_limit=3` });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("every seeded (pre-migration) user has mustChangePassword === false — the backfill ran, not just the default", async () => {
    const seeded = await owner.user.findMany({ where: { email: { endsWith: "@despl.local" } } });
    expect(seeded.length).toBeGreaterThan(0); // sanity: `pnpm db:seed` has run against this DB
    for (const u of seeded) {
      expect(u.mustChangePassword).toBe(false);
    }
  });

  it("every seeded user has a non-null, non-empty username backfilled from the email local-part", async () => {
    const seeded = await owner.user.findMany({ where: { email: { endsWith: "@despl.local" } } });
    for (const u of seeded) {
      expect(u.username).toBeTruthy();
      expect(u.username).toBe(u.email.split("@")[0]);
    }
    // Spot-check a specific known seeded row's derivation (migration.sql:
    // split_part(email, '@', 1)).
    const sj = seeded.find((u) => u.email === "sj@despl.local");
    expect(sj?.username).toBe("sj");
  });

  it("a freshly-created user defaults mustChangePassword=true, sessionVersion=0 — the DEFAULT, not the backfill, governs new rows", async () => {
    const org = await owner.organization.create({
      data: { code: `BACKFILL-${Date.now()}`, name: "Backfill test" },
    });
    const fresh = await owner.user.create({
      data: {
        tenantId: org.id,
        email: `fresh-${Date.now()}@x`,
        username: `fresh-${Date.now()}`,
        name: "Fresh",
        passwordHash: "x",
      },
    });
    expect(fresh.mustChangePassword).toBe(true);
    expect(fresh.sessionVersion).toBe(0);
  });

  it("ProcessPlan.assigneeUserId is null on a freshly-created plan with no explicit assignee", async () => {
    const org = await owner.organization.create({
      data: { code: `BACKFILL-PLAN-${Date.now()}`, name: "Backfill plan test" },
    });
    const dept = await owner.department.create({ data: { tenantId: org.id, code: "BF", name: "Backfill Dept" } });
    const client = await owner.client.create({ data: { tenantId: org.id, name: "BF Client" } });
    const family = await owner.productFamily.create({ data: { tenantId: org.id, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId: org.id, familyId: family.id, name: "PV template" } });
    const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId: org.id,
        publicId: `pub-bf-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-BF-${Date.now()}`,
      },
    });
    const jp = await owner.jobProcess.create({ data: { jobId: job.id, seq: 10, code: "10", name: "A", departmentId: dept.id } });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, equipmentId: null, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    const plan = await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: dept.id },
    });
    expect(plan.assigneeUserId).toBeNull();
  });
});
