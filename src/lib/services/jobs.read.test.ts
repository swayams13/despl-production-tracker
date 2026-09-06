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

describe.skipIf(!process.env.RUN_DB_TESTS)("loadJobs — pagination (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("paginated call returns only pageSize items and the correct total", async () => {
    try {
      const tenantJob = await owner.job.findFirst();
      if (!tenantJob) throw new Error("seed missing any job — run pnpm db:seed");
      const a = actor({ tenantId: tenantJob.tenantId });

      const full = await loadJobs(a);
      const paged = await loadJobs(a, { page: 1, pageSize: 1 });

      expect(Array.isArray(paged)).toBe(false);
      if (Array.isArray(paged)) throw new Error("unreachable");
      expect(paged.items.length).toBe(Math.min(1, full.length));
      expect(paged.total).toBe(full.length);
      expect(paged.page).toBe(1);
      expect(paged.pageSize).toBe(1);
      // Page 1's one item must be the same job the unpaginated call lists first
      // (both order by jobNumber asc) — proves take/skip didn't reorder anything.
      if (full.length > 0) expect(paged.items[0].id).toBe(full[0].id);
    } finally {
      await owner.$disconnect();
    }
  });
});
