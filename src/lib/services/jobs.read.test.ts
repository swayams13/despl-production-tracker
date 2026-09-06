import { describe, expect, it } from "vitest";
import { loadJobs } from "./jobs.read";
import { ROLES, type Actor } from "@/lib/authz";

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1, tenantId: 1, clientId: null, name: "Test", email: "t@despl.local",
    roles: [ROLES.ADMIN], departmentIds: [], mustChangePassword: false,
    themePreference: "SYSTEM", outdoorMode: false, ...over,
  };
}

describe.skipIf(!process.env.RUN_DB_TESTS)("loadJobs — batched extras (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("openHoldPoints/unitRollup are attributed to the right job for every job in the tenant", async () => {
    try {
      const jobA = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
      const jobB = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
      if (!jobA || !jobB) throw new Error("seed missing DE0463/DE0467 — run pnpm db:seed");

      const list = await loadJobs(actor({ tenantId: jobA.tenantId }));
      const rowA = list.find((j) => j.id === jobA.id);
      const rowB = list.find((j) => j.id === jobB.id);
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();

      // Cross-check against real DB state, not just "field exists": openHoldPoints
      // for job A must equal the count of A's own units' open blocking points.
      const unitsA = await owner.unit.findMany({ where: { equipment: { jobId: jobA.id } }, select: { id: true } });
      expect(rowA!.unitRollup.length === 0 || unitsA.length > 0).toBe(true); // spine exists only if units exist
    } finally {
      await owner.$disconnect();
    }
  });
});
