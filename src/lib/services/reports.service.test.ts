import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * §4.9 digest publish, DB-gated (needs a real seeded ORG/user/role chain).
 * Pins the notification body text difference between a human-triggered
 * "Send now" and the automatic daily cron run — the only externally visible
 * effect of the `auto` flag.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("publishDigest (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { publishDigest } = await import("./reports.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function actor(tenantId: number, userId: number, name: string, roles: string[]): Actor {
    return { userId, tenantId, clientId: null, name, email: `u${userId}@x`, roles: roles as never, departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  async function makeOrgWithManagementUser(suffix: string): Promise<{ tenantId: number; managementUserId: number }> {
    const org = await owner.organization.create({ data: { code: `DIGEST-${suffix}-${Date.now()}`, name: "Digest test" } });
    const mgmtRole = await owner.role.create({ data: { tenantId: org.id, code: "MANAGEMENT", name: "Management" } });
    const mgmt = await owner.user.create({
      data: { tenantId: org.id, email: `mgmt-${suffix}-${Date.now()}@x`, username: `mgmt-${suffix}-${Date.now()}`, name: "MGMT", passwordHash: "x" },
    });
    await owner.userRole.create({ data: { userId: mgmt.id, roleId: mgmtRole.id } });
    return { tenantId: org.id, managementUserId: mgmt.id };
  }

  it("manual publish (no opts) writes 'Sent by <name>'", async () => {
    const { tenantId, managementUserId } = await makeOrgWithManagementUser("manual");
    const ph = actor(tenantId, 999, "Production Head", [ROLES.PRODUCTION_HEAD]);

    const count = await publishDigest(ph, "2026-09-05");
    expect(count).toBe(1);

    const n = await owner.notification.findFirstOrThrow({ where: { type: "DIGEST_PUBLISHED", recipientId: managementUserId } });
    expect(n.body).toBe("Sent by Production Head");
  });

  it("automatic publish (auto: true) writes 'Sent automatically'", async () => {
    const { tenantId, managementUserId } = await makeOrgWithManagementUser("auto");
    const admin = actor(tenantId, 998, "System Admin", [ROLES.ADMIN]);

    const count = await publishDigest(admin, "2026-09-05", { auto: true });
    expect(count).toBe(1);

    const n = await owner.notification.findFirstOrThrow({ where: { type: "DIGEST_PUBLISHED", recipientId: managementUserId } });
    expect(n.body).toBe("Sent automatically");
  });
});
