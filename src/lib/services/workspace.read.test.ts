import { afterAll, describe, expect, it } from "vitest";
import { loadPrioritizedJob, loadOpenHoldPoints } from "./workspace.read";
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

  it("lists open blocking hold points (QcpItem 8/9 on seq 10, per Task 3/7)", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");

    const actor: Actor = {
      userId: 1,
      tenantId: job.tenantId,
      clientId: null,
      name: "QC",
      email: "qc@despl.test",
      roles: [ROLES.QC],
      departmentIds: [],
    };

    const open = await loadOpenHoldPoints(actor, job.id);

    expect(open.length).toBeGreaterThan(0);
    for (const row of open) {
      expect(typeof row.qcpItemId).toBe("number");
      expect(typeof row.activity).toBe("string");
      expect(typeof row.unitId).toBe("number");
      expect(typeof row.serialNo).toBe("string");
    }
    expect(open.some((r) => r.qcpItemId === 8 || r.qcpItemId === 9)).toBe(true);
  });
});
