import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * `login()`'s identity resolution (final whole-branch review, Finding 5).
 *
 * Every prior collision test (admin.service.test.ts) asserts from the
 * CREATION side — that a colliding username/email is refused. Nothing
 * called `login()` itself and asserted a given identifier resolves to
 * exactly one expected row, which is why the case-sensitivity bug (Finding
 * 1) survived 4 prior review rounds: the guards were tested, the property
 * they protect — "this identifier, however typed, is unambiguous" — was
 * not. This is that test.
 *
 * `login()` calls `createSession()` (next/headers `cookies()`) and finishes
 * with `redirect()` (next/navigation) — both throw or fail outside a real
 * request scope, so both are mocked the same way must-change-password.test.ts
 * and change-password.test.ts already mock them. Everything else (password
 * hash/verify, the DB lookup, JWT sign/verify) runs for real.
 *
 * `resolveTenantForLogin` resolves the ONE tenant by its seeded org code
 * ("DESPL"), ignoring its input — so unlike other DB-gated tests here, this
 * one cannot create its own throwaway tenant; it must run against the real
 * seeded DESPL tenant in the disposable `despl_test` database (never
 * `despl_demo` — see .env.test / project memory).
 */
let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "despl_session" && cookieValue !== undefined ? { value: cookieValue } : undefined),
    set: (name: string, value: string) => {
      if (name === "despl_session") cookieValue = value;
    },
    delete: (name: string) => {
      if (name === "despl_session") cookieValue = undefined;
    },
  }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("login() — identity resolution (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createEmployee } = await import("@/lib/services/admin.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let admin: Actor;

  beforeAll(async () => {
    const org = await owner.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
    tenantId = org.id;
    const adminRow = await owner.user.findFirstOrThrow({
      where: { tenantId, roles: { some: { role: { code: "ADMIN" } } } },
    });
    admin = {
      userId: adminRow.id,
      tenantId,
      clientId: null,
      name: adminRow.name,
      email: adminRow.email,
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("resolves a mixed-case-typed username to exactly the one matching row", async () => {
    const stamp = Date.now();
    const username = `logintest-${stamp}`; // stored lowercase (createEmployeeSchema)
    const password = "a-real-password-1";
    const created = await createEmployee(admin, {
      displayName: "Login Test",
      username,
      roles: ["QC"],
      departmentIds: [],
      password,
    });

    const { login } = await import("./auth");
    const { readSession } = await import("@/lib/auth/session");
    cookieValue = undefined;

    const form = new FormData();
    form.set("identifier", username.toUpperCase()); // typed with different case than stored
    form.set("password", password);
    const state = await login({}, form);

    expect(state?.error).toBeUndefined(); // no refusal — must not report "incorrect username/email/password"
    const session = await readSession();
    expect(session?.userId).toBe(created.userId); // resolved to exactly this one row, not ambiguous
  });

  it("still refuses an unknown username with the same generic message (no account enumeration)", async () => {
    const { login } = await import("./auth");
    cookieValue = undefined;

    const form = new FormData();
    form.set("identifier", `nobody-${Date.now()}`);
    form.set("password", "whatever-not-real-1");
    const state = await login({}, form);

    expect(state?.error).toBe("Incorrect username, email, or password");
    expect(cookieValue).toBeUndefined(); // no session was created
  });

  // Audit C4: brute force was unthrottled and left no trace at all.
  it("a failed login leaves a trace — writes an audit_log row", async () => {
    const { login } = await import("./auth");
    cookieValue = undefined;
    const identifier = `nobody-audit-${Date.now()}`;

    const form = new FormData();
    form.set("identifier", identifier);
    form.set("password", "whatever-not-real-1");
    await login({}, form);

    const rows = await owner.auditLog.findMany({
      where: { tenantId, action: "auth.loginFailed", entityId: identifier.toLowerCase() },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBeNull(); // no account matched this identifier
  });

  it("throttles repeated bad attempts against the same identifier", async () => {
    const { login } = await import("./auth");
    const identifier = `nobody-throttle-${Date.now()}`;

    async function attempt(password: string) {
      cookieValue = undefined;
      const form = new FormData();
      form.set("identifier", identifier);
      form.set("password", password);
      return login({}, form);
    }

    for (let i = 0; i < 5; i++) {
      const state = await attempt("whatever-not-real-1");
      expect(state?.error).toBe("Incorrect username, email, or password");
    }

    // 6th attempt within the window is throttled, even with a correct-shaped
    // password — proves the block fires on attempt count, not password checks.
    const throttled = await attempt("whatever-not-real-1");
    expect(throttled?.error).toBe("Too many attempts. Try again in a few minutes.");

    const rows = await owner.auditLog.count({
      where: { tenantId, action: "auth.loginFailed", entityId: identifier.toLowerCase() },
    });
    expect(rows).toBe(5); // the throttled 6th attempt never re-checked the password, so no 6th row
  });
});
