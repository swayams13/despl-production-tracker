import { describe, expect, it, beforeAll } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import {
  createEmployee,
  setUserActive,
  updateUserRolesDepts,
  createEquipmentType,
  createClientRecord,
  createProductFamily,
} from "./admin.service";

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
    themePreference: "SYSTEM",
    outdoorMode: false,
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

  it("createEquipmentType refuses a SUPERVISOR caller", async () => {
    await expect(
      createEquipmentType(actor({ roles: [ROLES.SUPERVISOR] }), {
        familyId: 1,
        code: "X",
        name: "X",
        defaultDesignCode: null,
        defaultSpecs: null,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createEquipmentType refuses a client user", async () => {
    await expect(
      createEquipmentType(actor({ clientId: 7, roles: [ROLES.CLIENT_VIEWER] }), {
        familyId: 1,
        code: "X",
        name: "X",
        defaultDesignCode: null,
        defaultSpecs: null,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createClientRecord refuses a QC caller", async () => {
    await expect(
      createClientRecord(actor({ roles: [ROLES.QC] }), { name: "Acme", code: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createProductFamily refuses a PRODUCTION_HEAD caller — ADMIN-only, unlike the other catalog writers", async () => {
    await expect(
      createProductFamily(actor({ roles: [ROLES.PRODUCTION_HEAD] }), { code: "PIPE_SPOOL", name: "Pipe Spool" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createProductFamily refuses a client user", async () => {
    await expect(
      createProductFamily(actor({ clientId: 7, roles: [ROLES.CLIENT_VIEWER] }), {
        code: "PIPE_SPOOL",
        name: "Pipe Spool",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createProductFamily refuses a lowercase or hyphenated code before touching the DB", async () => {
    await expect(
      createProductFamily(actor(), { code: "pipe-spool", name: "Pipe Spool" }),
    ).rejects.toThrow();
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
  const { createUser, resetUserPassword, approvePasswordReset } = await import("./admin.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let admin: Actor;
  let secondAdmin: Actor;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-ADMIN-${Date.now()}`, name: "Admin svc test" },
    });
    tenantId = org.id;
    const adminRole = await owner.role.create({ data: { tenantId, code: "ADMIN", name: "Admin" } });

    // AUD-079's PendingPasswordReset FKs (requestedBy/approvedBy/targetUserId
    // all reference real users.id) mean the actor used against
    // resetUserPassword/approvePasswordReset must be backed by a real row,
    // not the synthetic `userId: 1` this file used before that model
    // existed — so both admins below are real rows.
    const adminRow = await owner.user.create({
      data: {
        tenantId,
        email: "admin@test.local",
        username: `admin-${Date.now()}`,
        name: "Test Admin",
        passwordHash: "x",
      },
    });
    await owner.userRole.create({ data: { userId: adminRow.id, roleId: adminRole.id } });
    admin = {
      userId: adminRow.id,
      tenantId,
      clientId: null,
      name: "Test Admin",
      email: adminRow.email,
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    // A SECOND, distinct admin — resetting an ADMIN/QC target needs one to
    // approve (AUD-079).
    const secondAdminRow = await owner.user.create({
      data: {
        tenantId,
        email: `second-admin-${Date.now()}@test.local`,
        username: `second-admin-${Date.now()}`,
        name: "Second Admin",
        passwordHash: "x",
      },
    });
    await owner.userRole.create({ data: { userId: secondAdminRow.id, roleId: adminRole.id } });
    secondAdmin = {
      userId: secondAdminRow.id,
      tenantId,
      clientId: null,
      name: "Second Admin",
      email: secondAdminRow.email,
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  });

  it("creates a user with username derived from the email local-part", async () => {
    const user = await createUser(admin, {
      name: "Bob One",
      email: "bob@gmail.com",
      roleCodes: ["ADMIN"],
      departmentIds: [],
      password: "password123",
      mustChangePassword: true,
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
        mustChangePassword: true,
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
        mustChangePassword: true,
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  /**
   * AUD-079 (test #5 of the session's table): resetting another ADMIN's
   * password is one of the two roles that requires a second, distinct
   * admin's approval — same pending/approval flow as a QC target (test #2/#4
   * below, in the Task 4.1 describe block, cover QC specifically). Also
   * covers the original Final-review Finding 2 assertions (sessionVersion
   * bump, mustChangePassword re-armed) at the point they now actually land:
   * on approval, not on request.
   */
  it("resetUserPassword on an ADMIN target goes pending; a second admin's approval performs the real reset", async () => {
    const user = await createUser(admin, {
      name: "Reset Target",
      email: "resettarget@x.com",
      roleCodes: ["ADMIN"],
      departmentIds: [],
      password: "password123",
      mustChangePassword: true,
    });
    expect(user.sessionVersion).toBe(0);
    expect(user.mustChangePassword).toBe(true); // schema default for a new account

    // Simulate the user having completed their first-login change already:
    // the reset must re-arm the lock, not merely leave it set.
    await owner.user.update({
      where: { id: user.id },
      data: { mustChangePassword: false, sessionVersion: 3 },
    });

    const requested = await resetUserPassword(admin, { userId: user.id, password: "admin-chosen-1" });
    if (!("pending" in requested) || !requested.pending) throw new Error("expected a pending result");

    // Nothing changed yet — the whole point of the pending step.
    const unchangedRow = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchangedRow.sessionVersion).toBe(3);
    expect(unchangedRow.mustChangePassword).toBe(false);
    expect(unchangedRow.passwordHash).toBe(user.passwordHash);

    // The same admin who requested it cannot approve their own request.
    await expect(
      approvePasswordReset(admin, { requestId: requested.requestId }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.MAKER_CHECKER_VIOLATION);

    const approval = await approvePasswordReset(secondAdmin, { requestId: requested.requestId });
    expect(approval.tempPassword).toBeTruthy();

    const row = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.sessionVersion).toBe(4); // every pre-reset session token now fails getActor()
    expect(row.mustChangePassword).toBe(true);
    expect(row.passwordHash).not.toBe(user.passwordHash);

    // Invariant #5 + no password material in the trail, at either step.
    const requestAuditRow = await owner.auditLog.findFirst({
      where: { tenantId, entityType: "User", entityId: String(user.id), action: "admin.passwordReset.requested" },
      orderBy: { id: "desc" },
    });
    expect(requestAuditRow).toBeTruthy();
    expect(JSON.stringify(requestAuditRow?.after ?? "")).not.toContain("admin-chosen-1");

    const approveAuditRow = await owner.auditLog.findFirst({
      where: { tenantId, entityType: "User", entityId: String(user.id), action: "admin.passwordReset.approved" },
      orderBy: { id: "desc" },
    });
    expect(approveAuditRow).toBeTruthy();
    expect(JSON.stringify(approveAuditRow?.after ?? "")).not.toContain(approval.tempPassword);
  });

  it("approvePasswordReset refuses an already-approved or nonexistent request id", async () => {
    const user = await createUser(admin, {
      name: "Reset Target Two",
      email: "resettarget2@x.com",
      roleCodes: ["ADMIN"],
      departmentIds: [],
      password: "password123",
      mustChangePassword: true,
    });
    const requested = await resetUserPassword(admin, { userId: user.id });
    if (!("pending" in requested) || !requested.pending) throw new Error("expected a pending result");

    await approvePasswordReset(secondAdmin, { requestId: requested.requestId });

    // Already APPROVED — a second approval attempt must not find it PENDING.
    await expect(
      approvePasswordReset(secondAdmin, { requestId: requested.requestId }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.NOT_FOUND);

    // A request id that never existed.
    await expect(
      approvePasswordReset(secondAdmin, { requestId: 999_999_999 }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.NOT_FOUND);
  });

  it("resetUserPassword on a QC/Admin target notifies other admins (detective control)", async () => {
    const user = await createUser(admin, {
      name: "Reset Target Three",
      email: "resettarget3@x.com",
      roleCodes: ["ADMIN"],
      departmentIds: [],
      password: "password123",
      mustChangePassword: true,
    });
    await resetUserPassword(admin, { userId: user.id });

    // secondAdmin is a different, active ADMIN in this tenant — the alert
    // must reach them, not the requester.
    const alert = await owner.notification.findFirst({
      where: { tenantId, recipientId: secondAdmin.userId, type: "PASSWORD_RESET_SENSITIVE_TARGET", entityId: user.id },
      orderBy: { id: "desc" },
    });
    expect(alert).toBeTruthy();
  });
});

/**
 * C1 (route-authoring bootstrap): DB coverage for createProductFamily —
 * uniqueness on (tenantId, code), the audit row, and the code being
 * uppercased on write (input is lowercase, stored code is upper).
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
describe.skipIf(!RUN_DB)("admin.service createProductFamily (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let admin: Actor;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-FAMILY-${Date.now()}`, name: "Product family svc test" },
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
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  });

  it("creates a family, uppercasing the code, and writes an audit row", async () => {
    const family = await createProductFamily(admin, { code: "pipe_spool", name: "Pipe Spool" });
    expect(family.code).toBe("PIPE_SPOOL");
    expect(family.active).toBe(true);

    const auditRow = await owner.auditLog.findFirst({
      where: { tenantId, entityType: "ProductFamily", entityId: String(family.id), action: "admin.createProductFamily" },
      orderBy: { id: "desc" },
    });
    expect(auditRow).toBeTruthy();
  });

  it("rejects a duplicate code within the same tenant with a clean AppError", async () => {
    await expect(
      createProductFamily(admin, { code: "PIPE_SPOOL", name: "Pipe Spool Again" }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
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
  const {
    createEmployee,
    createUser,
    setUserActive,
    resetUserPassword,
    approvePasswordReset,
    updateUserRolesDepts,
    bulkImportEmployees,
  } = await import("./admin.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let deptId = 0;
  let admin: Actor;
  let secondAdmin: Actor;

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
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    // AUD-079: a second, distinct admin to approve QC/Admin-target resets.
    const secondAdminUser = await owner.user.create({
      data: {
        tenantId,
        email: `second-admin-${Date.now()}@test.local`,
        username: `second-admin-${Date.now()}`,
        name: "Second Admin",
        passwordHash: "x",
      },
    });
    await owner.userRole.create({ data: { userId: secondAdminUser.id, roleId: adminRole.id } });
    secondAdmin = {
      userId: secondAdminUser.id,
      tenantId,
      clientId: null,
      name: "Second Admin",
      email: secondAdminUser.email,
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
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

  // Final whole-branch review, Finding 1: `email` was lowercased at the
  // schema level, `username` never was — so a caller could evade the exact
  // guard above just by typing a different CASE, e.g. an admin creating a
  // user with username "Alice@Vendor.com" when "alice@vendor.com" already
  // exists as another account's email. `createEmployeeSchema.username` now
  // lowercases the same way `email` always has, so the collision query
  // below (which matches on the lowercased value) catches it.
  it("createEmployee rejects a username that case-insensitively collides with another account's email (case alone must not evade the guard)", async () => {
    const stamp = Date.now();
    const email = `casecollide-${stamp}@test.local`;
    await createEmployee(admin, { displayName: "Has Email", username: `hasemail3-${stamp}`, email, roles: ["QC"], departmentIds: [] });
    await expect(
      createEmployee(admin, { displayName: "Collider", username: email.toUpperCase(), roles: ["QC"], departmentIds: [] }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  it("createEmployee lowercases a mixed-case username at creation, so it is stored the same way `email` always is", async () => {
    const stamp = Date.now();
    const created = await createEmployee(admin, {
      displayName: "Mixed Case",
      username: `MixedCase-${stamp}`,
      roles: ["QC"],
      departmentIds: [],
    });
    expect(created.username).toBe(`mixedcase-${stamp}`);
    const row = await owner.user.findUniqueOrThrow({ where: { id: created.userId } });
    expect(row.username).toBe(row.username.toLowerCase());
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
        mustChangePassword: true,
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  // AUD-079 test table, #1: a SUPERVISOR target is NOT a QC/Admin account —
  // unaffected by the pending-approval flow, immediate reset exactly as
  // before this session.
  it("resetUserPassword generates a temp password when omitted, and re-arms mustChangePassword — SUPERVISOR target unaffected", async () => {
    const created = await createEmployee(admin, {
      displayName: "Reset Me",
      username: `resetme-${Date.now()}`,
      roles: ["SUPERVISOR"],
      departmentIds: [deptId],
    });
    await owner.user.update({ where: { id: created.userId }, data: { mustChangePassword: false } });

    const result = await resetUserPassword(admin, { userId: created.userId });
    if ("pending" in result && result.pending) throw new Error("SUPERVISOR target should reset immediately");
    expect(result.tempPassword).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
    expect(result.tempPassword).not.toBe(created.tempPassword);

    const row = await owner.user.findUniqueOrThrow({ where: { id: created.userId } });
    expect(row.mustChangePassword).toBe(true);
  });

  // AUD-079 test table, #2/#3/#4: a QC target goes pending, the requesting
  // admin cannot approve their own request, and a second distinct admin's
  // approval performs the real reset.
  it("resetUserPassword on a QC target goes pending; same-admin approval is refused; a different admin's approval resets it", async () => {
    const created = await createEmployee(admin, {
      displayName: "Reset QC",
      username: `resetqc-${Date.now()}`,
      roles: ["QC"],
      departmentIds: [],
    });
    await owner.user.update({ where: { id: created.userId }, data: { mustChangePassword: false } });

    const requested = await resetUserPassword(admin, { userId: created.userId });
    if (!("pending" in requested) || !requested.pending) throw new Error("expected a pending result for a QC target");

    // #2: no password returned to the requesting admin.
    expect("tempPassword" in requested).toBe(false);
    const unchanged = await owner.user.findUniqueOrThrow({ where: { id: created.userId } });
    expect(unchanged.mustChangePassword).toBe(false);

    // #3: the requesting admin cannot approve their own request.
    await expect(
      approvePasswordReset(admin, { requestId: requested.requestId }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.MAKER_CHECKER_VIOLATION);

    // #4: a distinct admin approves — the real reset happens now.
    const { tempPassword } = await approvePasswordReset(secondAdmin, { requestId: requested.requestId });
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
