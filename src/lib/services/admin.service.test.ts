import { describe, expect, it, beforeAll } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import { createEmployee, setUserActive, updateUserRolesDepts } from "./admin.service";

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "Admin",
    email: "admin@despl.test",
    roles: [ROLES.ADMIN],
    departmentIds: [],
    mustChangePassword: false,
    ...over,
  };
}

/**
 * Guard rails that are pure logic (no DB read needed to decide): checked
 * against the caller's own request/actor shape, same split as
 * assignment.service.test.ts's "pure refusals" tier.
 */
describe("admin.service — pure refusals", () => {
  it("setUserActive refuses an admin deactivating their own account, before touching the DB", async () => {
    const self = actor({ userId: 42 });
    await expect(setUserActive(self, { userId: 42, active: false })).rejects.toMatchObject({
      code: ERROR_CODES.CANNOT_SELF_DEACTIVATE,
    });
  });

  it("updateUserRolesDepts refuses an admin removing their own ADMIN role, before touching the DB", async () => {
    const self = actor({ userId: 42, roles: [ROLES.ADMIN] });
    await expect(
      updateUserRolesDepts(self, { userId: 42, roles: [ROLES.SUPERVISOR], departmentIds: [] }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CANNOT_SELF_DEMOTE });
  });

  it("updateUserRolesDepts refuses a client (read-only) user before touching the DB (invariant #8)", async () => {
    const clientUser = actor({ clientId: 99, roles: [ROLES.CLIENT_VIEWER] });
    await expect(
      updateUserRolesDepts(clientUser, { userId: 2, roles: [ROLES.QC], departmentIds: [] }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createEmployee refuses a non-ADMIN caller (RBAC deny-by-default)", async () => {
    const supervisor = actor({ roles: [ROLES.SUPERVISOR] });
    await expect(
      createEmployee(supervisor, {
        displayName: "New Hire",
        username: "newhire",
        roles: ["QC"],
        departmentIds: [],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("rejects a smuggled *_at key on createEmployee via the strict schema (invariant #1)", async () => {
    await expect(
      createEmployee(actor(), {
        displayName: "New Hire",
        username: "newhire",
        roles: ["QC"],
        departmentIds: [],
        // @ts-expect-error — .strict() schema; no timestamp field exists on this input
        createdAt: new Date(),
      }),
    ).rejects.toBeTruthy();
  });
});

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
  const { createUser, resetUserPassword } = await import("./admin.service");
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
      mustChangePassword: false,
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

  /**
   * Final-review Finding 2: an admin reset is a temp credential the admin
   * knows, and is the path most likely to be undoing a COMPROMISED one — so
   * it must both kill existing sessions (sessionVersion bump, which getActor()
   * compares against the token) and force the user to replace it.
   */
  it("resetUserPassword bumps sessionVersion and re-arms mustChangePassword", async () => {
    const user = await createUser(admin, {
      name: "Reset Target",
      email: "resettarget@x.com",
      roleCodes: ["ADMIN"],
      departmentIds: [],
      password: "password123",
    });
    expect(user.sessionVersion).toBe(0);
    expect(user.mustChangePassword).toBe(true); // schema default for a new account

    // Simulate the user having completed their first-login change already:
    // the reset must re-arm the lock, not merely leave it set.
    await owner.user.update({
      where: { id: user.id },
      data: { mustChangePassword: false, sessionVersion: 3 },
    });

    await resetUserPassword(admin, { userId: user.id, password: "admin-chosen-1" });

    const row = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.sessionVersion).toBe(4); // every pre-reset session token now fails getActor()
    expect(row.mustChangePassword).toBe(true);
    expect(row.passwordHash).not.toBe(user.passwordHash);

    // Invariant #5 + no password material in the trail.
    const auditRow = await owner.auditLog.findFirst({
      where: { tenantId, entityType: "User", entityId: String(user.id), action: "admin.resetPassword" },
      orderBy: { id: "desc" },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow?.before).toBeFalsy();
    expect(auditRow?.after).toBeFalsy();
  });
});

/**
 * DB-backed coverage for Task 4.1's five admin.service extensions (SPEC §5.2,
 * §10): createEmployee, setUserActive, resetUserPassword's generate-if-omitted
 * path, updateUserRolesDepts, bulkImportEmployees. Same RUN_DB_TESTS gate and
 * disposable-org pattern as the block above.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
describe.skipIf(!RUN_DB)("admin.service — Task 4.1 employee management (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createEmployee, createUser, setUserActive, resetUserPassword, updateUserRolesDepts, bulkImportEmployees } =
    await import("./admin.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let deptId = 0;
  let admin: Actor;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-EMP-${Date.now()}`, name: "Employee mgmt svc test" },
    });
    tenantId = org.id;
    await owner.role.createMany({
      data: [
        { tenantId, code: "ADMIN", name: "Admin" },
        { tenantId, code: "QC", name: "QC" },
        { tenantId, code: "SUPERVISOR", name: "Supervisor" },
      ],
    });
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    deptId = dept.id;

    const adminUser = await owner.user.create({
      data: {
        tenantId,
        email: `admin-${Date.now()}@test.local`,
        username: `admin-${Date.now()}`,
        name: "Test Admin",
        passwordHash: "x",
      },
    });
    const adminRole = await owner.role.findFirstOrThrow({ where: { tenantId, code: "ADMIN" } });
    await owner.userRole.create({ data: { userId: adminUser.id, roleId: adminRole.id } });

    admin = {
      userId: adminUser.id,
      tenantId,
      clientId: null,
      name: "Test Admin",
      email: adminUser.email,
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
    };
  });

  it("createEmployee generates a readable temp password and sets mustChangePassword", async () => {
    const created = await createEmployee(admin, {
      displayName: "Meera S",
      username: `meera-${Date.now()}`,
      roles: ["QC"],
      departmentIds: [deptId],
    });
    expect(created.tempPassword).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
    // Task 4.1 fix round: email omitted → returns the synthesized placeholder
    // that was actually stored, so a credential slip has something to print.
    expect(created.effectiveEmail).toBe(`${created.username}@no-email.despl.local`);

    const row = await owner.user.findUniqueOrThrow({ where: { id: created.userId } });
    expect(row.mustChangePassword).toBe(true);
    expect(row.name).toBe("Meera S");
    expect(row.email).toBe(created.effectiveEmail);
    // Never persisted in plaintext (SPEC §9) — the hash is not the temp password itself.
    expect(row.passwordHash).not.toBe(created.tempPassword);

    const auditRow = await owner.auditLog.findFirst({
      where: { tenantId, entityType: "User", entityId: String(created.userId), action: "admin.createEmployee" },
      orderBy: { id: "desc" },
    });
    expect(auditRow).toBeTruthy();
    // Invariant #5 / SPEC §9: no password material in the audit payload.
    expect(JSON.stringify(auditRow?.after)).not.toContain(created.tempPassword);
  });

  it("createEmployee honours an explicit password instead of generating one", async () => {
    const created = await createEmployee(admin, {
      displayName: "Explicit Pw",
      username: `explicitpw-${Date.now()}`,
      roles: ["QC"],
      departmentIds: [],
      password: "admin-chosen-password-1",
    });
    expect(created.tempPassword).toBe("admin-chosen-password-1");
  });

  it("createEmployee returns the supplied email as effectiveEmail when one is given", async () => {
    // NOT @despl.local: migration-backfill.test.ts asserts every @despl.local
    // row's username equals its email local-part, which this row (username
    // "hasemail-*", email "explicit-*") deliberately does not — same reason
    // the other fixtures in this file use @test.local / @x.com.
    const email = `explicit-${Date.now()}@test.local`;
    const created = await createEmployee(admin, {
      displayName: "Has Email",
      username: `hasemail-${Date.now()}`,
      email,
      roles: ["QC"],
      departmentIds: [],
    });
    expect(created.effectiveEmail).toBe(email);
  });

  it("createEmployee rejects a duplicate username with a clean AppError, not a DB crash", async () => {
    const username = `dupe-${Date.now()}`;
    await createEmployee(admin, { displayName: "First", username, roles: ["QC"], departmentIds: [] });
    await expect(
      createEmployee(admin, { displayName: "Second", username, roles: ["QC"], departmentIds: [] }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  // D13 collision guard (fix round 2): login() resolves an identifier via
  // OR: [{email}, {username}] with no ordering — username and email each
  // carry their own per-tenant unique constraint, not a joint one, so a new
  // row's username/email must be rejected if it collides with a DIFFERENT
  // existing row's email/username, or that identifier would resolve to an
  // unspecified one of two accounts at login.
  it("createEmployee rejects a username that collides with another account's email", async () => {
    const stamp = Date.now();
    const email = `collide-${stamp}@test.local`;
    await createEmployee(admin, { displayName: "Has Email", username: `hasemail2-${stamp}`, email, roles: ["QC"], departmentIds: [] });
    await expect(
      createEmployee(admin, { displayName: "Collider", username: email, roles: ["QC"], departmentIds: [] }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  it("createEmployee rejects an email that collides with another account's username", async () => {
    const stamp = Date.now();
    const username = `taken-${stamp}@test.local`; // email-shaped username, on purpose
    await createEmployee(admin, { displayName: "Odd Username", username, roles: ["QC"], departmentIds: [] });
    await expect(
      createEmployee(admin, {
        displayName: "Collider",
        username: `collider2-${stamp}`,
        email: username,
        roles: ["QC"],
        departmentIds: [],
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  // Fix round 3: createUser was missing the same guard from its own
  // direction — a createEmployee'd account can have an email-shaped
  // username (no format constraint on that field), and createUser never
  // checked its email against existing USERNAMES, only existing emails and
  // its own derived username.
  it("createUser rejects an email that collides with an existing createEmployee username", async () => {
    const stamp = Date.now();
    const emailShapedUsername = `vendor-${stamp}@vendor.local`;
    await createEmployee(admin, {
      displayName: "Odd Username Two",
      username: emailShapedUsername,
      roles: ["QC"],
      departmentIds: [],
    });
    await expect(
      createUser(admin, {
        name: "Collider",
        email: emailShapedUsername,
        roleCodes: ["QC"],
        departmentIds: [],
        password: "password123",
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  it("resetUserPassword generates a temp password when omitted, and re-arms mustChangePassword", async () => {
    const created = await createEmployee(admin, {
      displayName: "Reset Me",
      username: `resetme-${Date.now()}`,
      roles: ["QC"],
      departmentIds: [],
    });
    await owner.user.update({ where: { id: created.userId }, data: { mustChangePassword: false } });

    const { tempPassword } = await resetUserPassword(admin, { userId: created.userId });
    expect(tempPassword).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
    expect(tempPassword).not.toBe(created.tempPassword);

    const row = await owner.user.findUniqueOrThrow({ where: { id: created.userId } });
    expect(row.mustChangePassword).toBe(true);
  });

  it("setUserActive deactivates a user, bumps sessionVersion, and their login-lookup goes dark", async () => {
    const created = await createEmployee(admin, {
      displayName: "Deactivate Me",
      username: `deactivateme-${Date.now()}`,
      roles: ["QC"],
      departmentIds: [],
    });
    const before = await owner.user.findUniqueOrThrow({ where: { id: created.userId } });
    expect(before.active).toBe(true);

    const updated = await setUserActive(admin, { userId: created.userId, active: false });
    expect(updated.active).toBe(false);
    expect(updated.sessionVersion).toBe(before.sessionVersion + 1);

    // getActor()'s own lookup (src/lib/authz/index.ts) filters on active:true —
    // this is the DB-level proof that a deactivated user's session resolves
    // to nothing, i.e. "login refused" without re-driving the whole auth stack.
    const loginLookup = await owner.user.findFirst({ where: { id: created.userId, active: true } });
    expect(loginLookup).toBeNull();

    const auditRow = await owner.auditLog.findFirst({
      where: { tenantId, entityType: "User", entityId: String(created.userId), action: "admin.setUserActive" },
      orderBy: { id: "desc" },
    });
    expect(auditRow?.before).toMatchObject({ active: true });
    expect(auditRow?.after).toMatchObject({ active: false });
  });

  it("setUserActive(active: true) reactivates without bumping sessionVersion", async () => {
    const created = await createEmployee(admin, {
      displayName: "Reactivate Me",
      username: `reactivateme-${Date.now()}`,
      roles: ["QC"],
      departmentIds: [],
    });
    await setUserActive(admin, { userId: created.userId, active: false });
    const deactivated = await owner.user.findUniqueOrThrow({ where: { id: created.userId } });

    const reactivated = await setUserActive(admin, { userId: created.userId, active: true });
    expect(reactivated.active).toBe(true);
    expect(reactivated.sessionVersion).toBe(deactivated.sessionVersion); // no bump on reactivation
  });

  it("updateUserRolesDepts replaces roles/departments and audits a full before→after diff", async () => {
    const created = await createEmployee(admin, {
      displayName: "Role Change",
      username: `rolechange-${Date.now()}`,
      roles: ["QC"],
      departmentIds: [deptId],
    });

    const updated = await updateUserRolesDepts(admin, {
      userId: created.userId,
      roles: ["SUPERVISOR"],
      departmentIds: [],
    });
    expect(updated.id).toBe(created.userId);

    const roleRows = await owner.userRole.findMany({ where: { userId: created.userId }, include: { role: true } });
    expect(roleRows.map((r) => r.role.code)).toEqual(["SUPERVISOR"]);
    const deptRows = await owner.userDepartment.findMany({ where: { userId: created.userId } });
    expect(deptRows).toHaveLength(0);

    const auditRow = await owner.auditLog.findFirst({
      where: {
        tenantId,
        entityType: "User",
        entityId: String(created.userId),
        action: "admin.updateUserRolesDepts",
      },
      orderBy: { id: "desc" },
    });
    expect(auditRow?.before).toMatchObject({ roleCodes: ["QC"], departmentIds: [deptId] });
    expect(auditRow?.after).toMatchObject({ roleCodes: ["SUPERVISOR"], departmentIds: [] });
  });

  it("bulkImportEmployees: a bad row never rolls back the good rows around it", async () => {
    const stamp = Date.now();
    const rows = [
      { displayName: "Good One", username: `bulk-good1-${stamp}`, roles: ["QC"], departmentIds: [] },
      // Missing required "roles" — fails zod validation, never reaches the DB.
      { displayName: "Bad Shape", username: `bulk-bad-${stamp}` },
      { displayName: "Good Two", username: `bulk-good2-${stamp}`, roles: ["QC"], departmentIds: [] },
      // Duplicate of row 1's username — fails createEmployee's own DB pre-check.
      { displayName: "Duplicate", username: `bulk-good1-${stamp}`, roles: ["QC"], departmentIds: [] },
    ];

    const results = await bulkImportEmployees(admin, rows);
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({ ok: true, username: `bulk-good1-${stamp}` });
    expect(results[1]).toMatchObject({ ok: false });
    expect(results[2]).toMatchObject({ ok: true, username: `bulk-good2-${stamp}` });
    expect(results[3]).toMatchObject({ ok: false });

    const good1 = await owner.user.findFirst({ where: { tenantId, username: `bulk-good1-${stamp}` } });
    const good2 = await owner.user.findFirst({ where: { tenantId, username: `bulk-good2-${stamp}` } });
    expect(good1).toBeTruthy();
    expect(good2).toBeTruthy();
  });

  it("bulkImportEmployees strips password fields from a failed row's echoed report", async () => {
    const stamp = Date.now();
    // Not a documented CSV column, but a defensive strip must catch it
    // regardless — this row also fails validation (no "roles") so it takes
    // the safeParse-failure branch.
    const rows = [
      { displayName: "Leaky", username: `bulk-leak-${stamp}`, password: "hunter2", tempPassword: "shh-123" },
    ];

    const results = await bulkImportEmployees(admin, rows);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    const failed = results[0] as { ok: false; row: unknown; error: string };
    expect(failed.row).not.toHaveProperty("password");
    expect(failed.row).not.toHaveProperty("tempPassword");
    expect(failed.row).toMatchObject({ displayName: "Leaky", username: `bulk-leak-${stamp}` });
  });
});
