import { afterAll, describe, expect, it } from "vitest";
import { resolveTenantForLogin } from "./tenant-resolution";

/**
 * Regression coverage for the 16 Aug 2026 login outage: `resolveTenantForLogin`
 * used to be `findMany({take: 2}); if (orgs.length === 1) return orgs[0].id`,
 * which broke EVERY login the moment any unrelated row existed in
 * `organizations` — e.g. leaked `TEST-*`/`DELAY-*` fixtures from a DB-gated
 * test run pointed at the wrong database (see progress.md). Resolving by the
 * seeded tenant's own code instead of counting rows means unrelated rows
 * (test pollution, a future second tenant that hasn't onboarded yet, whatever)
 * can never defeat this lookup again.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("resolveTenantForLogin (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: `${process.env.DIRECT_URL}?connection_limit=3` });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("resolves the real DESPL tenant even with unrelated rows present (the exact pollution scenario that broke login)", async () => {
    // Simulate the leaked-fixture pattern that caused the outage: several
    // rows with unrelated codes, none of them "DESPL".
    for (let i = 0; i < 3; i++) {
      await owner.organization.create({
        data: { code: `TEST-TENANTRES-${Date.now()}-${i}`, name: "Pollution fixture" },
      });
    }

    const real = await owner.organization.findUnique({ where: { code: "DESPL" } });
    expect(real).not.toBeNull(); // sanity: the seeded tenant exists on this DB

    const resolved = await resolveTenantForLogin("anyone@despl.local");
    expect(resolved).toBe(real!.id);
  });
  // The "no DESPL org exists" branch (returns null) isn't covered here: this
  // DB always has a real seeded DESPL row, and deleting it to exercise that
  // branch would be destructive to shared dev/test data for a one-line
  // `org?.id ?? null` fallback. Low risk left uncovered.
});
