import { afterAll, describe, expect, it } from "vitest";
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
