import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPortfolio } from "./portfolio.read";
import { HEALTH_ORDER } from "./job-health";
import { ROLES, type Actor } from "@/lib/authz";

describe.skipIf(!process.env.RUN_DB_TESTS)("portfolio.read (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function sjActor(): Promise<Actor> {
    const org = await owner.organization.findFirst({ select: { id: true } });
    if (!org) throw new Error("no organization — run pnpm db:seed");
    return {
      userId: 1,
      tenantId: org.id,
      clientId: null,
      name: "SJ",
      email: "sj@despl.test",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  }

  it("returns every non-cancelled job exactly once, worst-first", async () => {
    const p = await loadPortfolio(await sjActor());

    expect(p.rows.length).toBeGreaterThan(0);
    const ids = p.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    // No cancelled job is ever a row.
    expect(p.rows.every((r) => r.health !== ("CANCELLED" as never))).toBe(true);

    // Sorted worst-first by HEALTH_ORDER.
    const ranks = p.rows.map((r) => HEALTH_ORDER.indexOf(r.health));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("tile counts reconcile exactly with the rows they filter to", async () => {
    const p = await loadPortfolio(await sjActor());

    for (const h of HEALTH_ORDER) {
      expect(p.counts[h]).toBe(p.rows.filter((r) => r.health === h).length);
    }
    // `active` is the ACTIVE-status denominator, not a seventh bucket.
    expect(p.counts.active).toBe(p.rows.filter((r) => r.status === "ACTIVE").length);
  });

  it("scopes a client user to their own client's jobs only", async () => {
    const clientUser = await owner.user.findFirst({
      where: { clientId: { not: null } },
      select: { id: true, tenantId: true, clientId: true },
    });
    if (!clientUser) return; // seed has no client user — nothing to assert

    const actor: Actor = {
      userId: clientUser.id,
      tenantId: clientUser.tenantId,
      clientId: clientUser.clientId,
      name: "client",
      email: "client@despl.test",
      roles: [ROLES.CLIENT_VIEWER],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    const p = await loadPortfolio(actor);

    // Asserted as "no returned row belongs to another client" rather than
    // "every returned row is in a snapshot of this client's jobs": suites run in
    // parallel and notifications.service.test.ts creates then deletes a fixture
    // job on this client, so a snapshot taken after the read could legitimately
    // be missing a row loadPortfolio had correctly returned. This form has no
    // such race and still fails on a real leak.
    const returned = await owner.job.findMany({
      where: { id: { in: p.rows.map((r) => r.id) } },
      select: { tenantId: true, clientId: true },
    });
    expect(
      returned.every((j) => j.tenantId === clientUser.tenantId && j.clientId === clientUser.clientId),
    ).toBe(true);
  });

  it("tallies cancelled jobs into cancelledCount instead of dropping them silently", async () => {
    const actor = await sjActor();
    const before = await loadPortfolio(actor);

    // Don't rely on the seed happening to have a CANCELLED job — insert a
    // throwaway one, same convention as delay.service.test.ts's Date.now()
    // -unique fixture rows. despl_test is the disposable DB-gated tier, so no
    // cleanup. Borrow FK values off any existing job in this tenant.
    const existing = await owner.job.findFirst({
      where: { tenantId: actor.tenantId },
      select: { clientId: true, familyId: true, templateVersionId: true },
    });
    if (!existing) throw new Error("no seeded job to borrow FK values from — run pnpm db:seed");

    await owner.job.create({
      data: {
        tenantId: actor.tenantId,
        publicId: `pub-cancel-test-${Date.now()}`,
        clientId: existing.clientId,
        familyId: existing.familyId,
        templateVersionId: existing.templateVersionId,
        jobNumber: `CANCEL-TEST-${Date.now()}`,
        status: "CANCELLED",
      },
    });

    const after = await loadPortfolio(actor);
    expect(after.cancelledCount).toBe(before.cancelledCount + 1);
  });

  it("classifies DE0463 and DE0467 as delayed once scheduled", async (ctx) => {
    const p = await loadPortfolio(await sjActor());
    const rows = ["DE0463", "DE0467"].map((n) => p.rows.find((r) => r.jobNumber === n));

    // `prisma/seed.ts` creates both jobs but never schedules them — that is the
    // one-off `pnpm db:bootstrap <jobNumber>`. So a fresh `migrate reset && seed`
    // legitimately has no plans here. Skip rather than fail the whole file.
    if (rows.some((r) => !r || r.totalPlans === 0)) {
      const msg =
        "DE0463/DE0467 have no schedule — run `pnpm db:bootstrap DE0463` and `pnpm db:bootstrap DE0467` to cover this case";
      console.warn(`[skip] ${msg}`);
      ctx.skip(msg);
    }

    for (const row of rows) expect(row!.health).toBe("DELAYED");
  });
});

/**
 * Session 14 (AUD-028/AUD-059): the `verified` sub-select inside `changes`
 * (portfolio.read.ts:69) used to join `pp.id = de.aggregate_id::int` —
 * casting the polymorphic `domain_events.aggregate_id` column itself. Fixed
 * to `pp.id::text = de.aggregate_id`, matching reports.read.ts/myday.read.ts.
 * Fresh tenant + own job (delay.service.test.ts's shape) so this is
 * independent of the shared-seed rows the describe block above reads.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadPortfolio — verifiedLast24h from domain_events (DB, AUD-028/059)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let jobId = 0;

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `PORTACT-${Date.now()}`, name: "portfolio.read activity test" } });
    tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "PROD", name: "Production" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-portact-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-PORTACT-${Date.now()}`,
      },
    });
    jobId = job.id;
    const jp = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 10, code: "10", name: "Rolling", departmentId: dept.id },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date("2026-01-01"), isCurrent: true },
    });
    const plan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: dept.id, status: "COMPLETE" },
    });

    // Inside the rolling 24h window — must count.
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(plan.id), type: "ProcessVerified", payload: {}, at: new Date() },
    });
    // Outside the window — must NOT count.
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(plan.id), type: "ProcessVerified", payload: {}, at: new Date(Date.now() - 48 * 3600 * 1000) },
    });
    // A row for a different aggregate_type with a non-numeric aggregate_id —
    // proves AUD-059's correctness fix (no cast-of-the-column runtime error).
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "Ncr", aggregateId: "ncr-not-numeric", type: "NcrRaised", payload: {}, at: new Date() },
    });
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function sjActor(): Promise<Actor> {
    return {
      userId: 1, tenantId, clientId: null, name: "SJ", email: "sj@despl.test",
      roles: [ROLES.PRODUCTION_HEAD], departmentIds: [], mustChangePassword: false,
      themePreference: "SYSTEM", outdoorMode: false,
    };
  }

  it("counts only the in-window ProcessVerified event, without throwing on the unrelated non-numeric row", async () => {
    const p = await loadPortfolio(await sjActor());
    const row = p.rows.find((r) => r.id === jobId);
    expect(row).toBeDefined();
    expect(row!.verifiedLast24h).toBe(1);
  });
});
