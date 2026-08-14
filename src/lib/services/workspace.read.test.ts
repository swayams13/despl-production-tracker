import { afterAll, describe, expect, it } from "vitest";
import { loadPrioritizedJob } from "./workspace.read";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * Read-only wiring: spine + CPM + prioritizer against real bootstrapped data.
 * No pure-testable surface without the DB, so this is skip-gated on
 * RUN_DB_TESTS=1 against a `pnpm db:seed`ed + bootstrapped database (DESPL-320
 * has a current run with 324 plans per the P4.0 bootstrap).
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadPrioritizedJob (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("loads DESPL-320's current run, ranked per department", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");

    const actor: Actor = {
      userId: 1,
      tenantId: job.tenantId,
      clientId: null,
      name: "SJ",
      email: "sj@despl.test",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
    };

    const result = await loadPrioritizedJob(actor, job.id);

    expect(result).not.toBeNull();
    expect(result!.rankedByDept.size).toBeGreaterThan(0);
    expect(result!.departments.length).toBeGreaterThan(0);
    expect(result!.processNameById.size).toBeGreaterThan(0);
  });
});
