import { afterAll, describe, expect, it } from "vitest";

/**
 * UPDATE (16 Aug 2026): despl_test was reset (`prisma migrate reset`) this
 * session to clear ~months of no-cleanup DB-gated test accumulation (524
 * orgs / 132K+ process_plans rows had made some queries slow enough to break
 * unrelated tests). That reset consumed exactly the scenario the CAVEAT below
 * used to warn about — this file's first two cases no longer prove Task
 * 1.1's migration backfill ran; `pnpm db:seed`'s own explicit field values
 * (`mustChangePassword: false`, `username: email.split("@")[0]` in
 * `prisma/seed.ts`'s `mkUser`) now determine the outcome on every reseed,
 * regardless of whether the migration's backfill logic is even correct. The
 * migration itself was verified correct at the time it shipped (see
 * progress.md / the SDD ledger for that historical record) — it doesn't need
 * a live re-proof on a DB that gets periodically reset. Retitled and
 * reframed below as seed-behavior regression tests, which is what they
 * actually check now; the original CAVEAT is kept for context on why.
 *
 * Original doc (Task 1.1's person-grain migration,
 * prisma/migrations/20260816175249_person_grain, did two DIFFERENT things
 * per column): must_change_password was added nullable, EVERY existing row
 * backfilled to false via a plain UPDATE, THEN the column got NOT NULL
 * DEFAULT true — so pre-migration rows carried false from the backfill while
 * brand-new rows carried true from the default. username was added nullable,
 * backfilled via split_part(email, '@', 1), then made NOT NULL.
 *
 * CAVEAT (now realized, kept for the next person who resets this DB again):
 * the seeded-user assertions only prove the backfill ran if despl_test still
 * carries @despl.local rows older than the migration. Once reset+reseeded,
 * pnpm db:seed runs AFTER the column's DEFAULT/explicit-value logic already
 * exists — every seeded row reflects seed.ts's own values, not any
 * historical backfill. That's expected, not a regression.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Task 1.1 migration backfill (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  // connection_limit is set once, for every DB-gated test file, on DIRECT_URL
  // itself in .env.test (was a per-file `?connection_limit=3` here and in
  // d16-gate-independence.test.ts; moved to the single env-var source so the
  // app's own `prisma` singleton — which DATABASE_URL fed uncapped — gets the
  // same cap, and so no file risks double-appending a query string).
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("every seeded demo user has mustChangePassword === false — prisma/seed.ts's mkUser sets it explicitly, so demo accounts are never locked behind the first-login interstitial", async () => {
    const seeded = await owner.user.findMany({ where: { email: { endsWith: "@despl.local" } } });
    expect(seeded.length).toBeGreaterThan(0); // sanity: `pnpm db:seed` has run against this DB
    for (const u of seeded) {
      expect(u.mustChangePassword).toBe(false);
    }
  });

  it("every seeded user has a non-null, non-empty username derived from the email local-part (seed.ts's mkUser sets it explicitly)", async () => {
    const seeded = await owner.user.findMany({ where: { email: { endsWith: "@despl.local" } } });
    for (const u of seeded) {
      expect(u.username).toBeTruthy();
      expect(u.username).toBe(u.email.split("@")[0]);
    }
    // Spot-check a specific known seeded row's derivation — matches both
    // seed.ts's mkUser (email.split("@")[0]) and the original migration's
    // backfill SQL (split_part(email, '@', 1)), same rule either way.
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
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: dept.id },
    });
    expect(plan.assigneeUserId).toBeNull();
  });
});
