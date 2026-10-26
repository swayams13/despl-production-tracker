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
// The caller's address as the reverse proxy would report it (AUD-109).
let callerIp = "203.0.113.1";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": callerIp }),
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

  // AUD-109: the throttle must not let a stranger lock out a named user.
  describe("throttle is per (identifier, client IP)", () => {
    const password = "a-real-password-1";
    async function attempt(identifier: string, pw: string, ip: string) {
      const { login } = await import("./auth");
      cookieValue = undefined;
      callerIp = ip;
      const form = new FormData();
      form.set("identifier", identifier);
      form.set("password", pw);
      return login({}, form);
    }

    it("five bad attempts from one address do not lock the real user out from another", async () => {
      const username = `lockout-${Date.now()}`;
      const created = await createEmployee(admin, { displayName: "Lockout Victim", username, roles: ["QC"], departmentIds: [], password });
      const attacker = "198.51.100.7";
      for (let i = 0; i < 5; i++) {
        expect((await attempt(username, "wrong-password-1", attacker))?.error).toBe("Incorrect username, email, or password");
      }
      // The attacker is now throttled for this identifier...
      expect((await attempt(username, password, attacker))?.error).toBe("Too many attempts. Try again in a few minutes.");
      // ...but the user at their own address signs in.
      const { readSession } = await import("@/lib/auth/session");
      expect((await attempt(username, password, "192.0.2.44"))?.error).toBeUndefined();
      expect((await readSession())?.userId).toBe(created.userId);
    });

    it("failed attempts are audited with the address", async () => {
      const identifier = `nobody-ip-${Date.now()}`;
      await attempt(identifier, "whatever-not-real-1", "198.51.100.99");
      const row = await owner.auditLog.findFirstOrThrow({ where: { tenantId, action: "auth.loginFailed", entityId: identifier } });
      expect(row.ip).toBe("198.51.100.99");
    });

    it("one address spraying many identifiers is stopped by the per-IP ceiling", async () => {
      const ip = `198.51.100.${100 + (Date.now() % 100)}`;
      const stamp = Date.now();
      for (let i = 0; i < 30; i++) {
        expect((await attempt(`spray-${stamp}-${i}`, "whatever-not-real-1", ip))?.error).toBe("Incorrect username, email, or password");
      }
      expect((await attempt(`spray-${stamp}-fresh`, "whatever-not-real-1", ip))?.error).toBe("Too many attempts. Try again in a few minutes.");
      // Another address is unaffected.
      expect((await attempt(`spray-${stamp}-fresh`, "whatever-not-real-1", "192.0.2.200"))?.error).toBe("Incorrect username, email, or password");
    });
  });
});
