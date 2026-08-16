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

    const jobs = await owner.job.findMany({
      where: { tenantId: clientUser.tenantId, clientId: clientUser.clientId! },
      select: { id: true },
    });
    const allowed = new Set(jobs.map((j) => j.id));
    expect(p.rows.every((r) => allowed.has(r.id))).toBe(true);
  });

  it("tallies cancelled jobs into cancelledCount instead of dropping them silently", async () => {
    const actor = await sjActor();
    const p = await loadPortfolio(actor);

    const cancelled = await owner.job.count({
      where: { tenantId: actor.tenantId, status: "CANCELLED" },
    });
    expect(p.cancelledCount).toBe(cancelled);
  });

  it("classifies DE0463 and DE0467 as delayed once scheduled", async () => {
    const p = await loadPortfolio(await sjActor());

    for (const jobNumber of ["DE0463", "DE0467"]) {
      const row = p.rows.find((r) => r.jobNumber === jobNumber);
      if (!row) throw new Error(`${jobNumber} missing — run pnpm db:bootstrap ${jobNumber}`);
      expect(row.totalPlans).toBeGreaterThan(0);
      expect(row.health).toBe("DELAYED");
    }
  });
});
