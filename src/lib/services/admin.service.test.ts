import { describe, expect, it, beforeAll } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * DB-backed coverage for createUser's uniqueness pre-checks. Gated off by
 * default; set RUN_DB_TESTS=1 with DIRECT_URL pointing at a migrated
 * database to run it — same pattern as process.service.test.ts.
 *
 * Covers the finding from Task 1.1 review: username is derived from the
 * email local-part and is @@unique([tenantId, username]) at the DB level,
 * so two different email domains sharing a local-part (bob@gmail.com,
 * bob@yahoo.com) must be rejected with a clean AppError, not a raw P2002
 * crash — createUser has no repo-wide Prisma error handler.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("admin.service createUser (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createUser } = await import("./admin.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let admin: Actor;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-ADMIN-${Date.now()}`, name: "Admin svc test" },
    });
    tenantId = org.id;
    await owner.role.create({ data: { tenantId, code: "ADMIN", name: "Admin" } });

    admin = {
      userId: 1,
      tenantId,
      clientId: null,
      name: "Test Admin",
      email: "admin@test.local",
      roles: [ROLES.ADMIN],
      departmentIds: [],
    };
  });

  it("creates a user with username derived from the email local-part", async () => {
    const user = await createUser(admin, {
      name: "Bob One",
      email: "bob@gmail.com",
      roleCodes: ["ADMIN"],
      departmentIds: [],
      password: "password123",
    });
    expect(user.username).toBe("bob");
  });

  it("rejects a duplicate email with a clean AppError, not a DB crash", async () => {
    await expect(
      createUser(admin, {
        name: "Bob Duplicate",
        email: "bob@gmail.com",
        roleCodes: ["ADMIN"],
        departmentIds: [],
        password: "password123",
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  it("rejects a same-local-part different-domain email with a clean AppError, not a DB crash", async () => {
    // bob@gmail.com already exists; bob@yahoo.com collides on the derived
    // username ("bob") without colliding on email — the exact gap the fix closes.
    await expect(
      createUser(admin, {
        name: "Bob Two",
        email: "bob@yahoo.com",
        roleCodes: ["ADMIN"],
        departmentIds: [],
        password: "password123",
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });
});
