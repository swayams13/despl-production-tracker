import { describe, it, expect, vi, beforeAll } from "vitest";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { Actor } from "@/lib/authz";

/**
 * First-login password change (personal dashboards v1, Task 1.3).
 *
 * `changeOwnPassword` internally calls `createSession()` (to refresh the
 * caller's own cookie after bumping `sessionVersion`), and the
 * session-invalidation test below also calls `getActor()`, which calls
 * `readSession()`. Both go through `next/headers`'s `cookies()` — verified
 * empirically that this throws ("called outside a request scope") in a bare
 * vitest run with no Next.js request context, and no existing test in this
 * repo exercises session.ts directly. Mocked here with a single-slot
 * in-memory jar standing in for a real cookie store, so the actual signed
 * JWT + DB sessionVersion comparison logic runs for real, not simulated.
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

function pureActor(): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "x",
    email: "x@x",
    roles: [],
    departmentIds: [],
    mustChangePassword: true,
    themePreference: "SYSTEM",
    outdoorMode: false,
  };
}

describe("changeOwnPassword — pure schema refusals", () => {
  it("rejects a next password under 10 characters before touching the DB", async () => {
    const { changeOwnPassword } = await import("./change-password");
    await expect(
      changeOwnPassword(pureActor(), { current: "whatever12", next: "short" }),
    ).rejects.toBeTruthy();
  });

  it("rejects a smuggled unknown key via the strict schema (invariant #1)", async () => {
    const { changeOwnPassword } = await import("./change-password");
    await expect(
      changeOwnPassword(pureActor(), {
        current: "whatever12",
        next: "newpassword1",
        // @ts-expect-error — .strict() schema; no timestamp field exists on this input
        changedAt: new Date(),
      }),
    ).rejects.toBeTruthy();
  });

  it("rejects next === current with PASSWORD_UNCHANGED before touching the DB (an admin-known temp password can never stay live)", async () => {
    const { changeOwnPassword } = await import("./change-password");
    await expect(
      changeOwnPassword(pureActor(), { current: "same-password-1", next: "same-password-1" }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.PASSWORD_UNCHANGED);
  });
});

/**
 * Behavioural round-trip against a live DB. Gated off unless RUN_DB_TESTS=1
 * (pnpm test:db, against despl_test only — never the bare DB per project
 * memory). Each case uses its OWN fresh user/tenant (rather than sharing one
 * across cases) so the rate-limit counter (keyed on actorId) and audit-row
 * assertions never depend on test execution order.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("changeOwnPassword (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { hashPassword, verifyPassword } = await import("@/lib/auth/password");
  const { changeOwnPassword } = await import("./change-password");
  const { createSession } = await import("@/lib/auth/session");
  const { getActor } = await import("@/lib/authz");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const INITIAL_PASSWORD = "initial-password-1";

  async function mkUser(): Promise<{ tenantId: number; userId: number; actor: Actor }> {
    const org = await owner.organization.create({
      data: { code: `TEST-PWCHANGE-${Date.now()}-${Math.random()}`, name: "Password change test" },
    });
    const tenantId = org.id;
    const passwordHash = await hashPassword(INITIAL_PASSWORD);
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `pw-${Date.now()}-${Math.random()}@x`,
        username: `pw-${Date.now()}-${Math.random()}`,
        name: "PW Test",
        passwordHash,
        mustChangePassword: true,
      },
    });
    const actor: Actor = {
      userId: user.id,
      tenantId,
      clientId: null,
      name: user.name,
      email: user.email,
      roles: [],
      departmentIds: [],
      mustChangePassword: true,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    return { tenantId, userId: user.id, actor };
  }

  beforeAll(() => {
    cookieValue = undefined;
  });

  it("wrong current password → INVALID_CURRENT_PASSWORD, and records a failed-attempt audit row", async () => {
    const { tenantId, userId, actor } = await mkUser();

    await expect(
      changeOwnPassword(actor, { current: "totally-wrong", next: "brand-new-password-1" }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.INVALID_CURRENT_PASSWORD);

    const failRow = await owner.auditLog.findFirst({
      where: { tenantId, actorId: userId, action: "auth.changePasswordFailed" },
    });
    expect(failRow).toBeTruthy();

    // The user row itself is untouched by a failed attempt.
    const row = await owner.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.mustChangePassword).toBe(true);
    expect(row.sessionVersion).toBe(0);
  });

  it("rate-limits after 5 recent failed attempts, refusing even a correct password on the 6th", async () => {
    const { actor } = await mkUser();

    for (let i = 0; i < 5; i++) {
      await expect(
        changeOwnPassword(actor, { current: "still-wrong", next: "brand-new-password-1" }),
      ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.INVALID_CURRENT_PASSWORD);
    }

    await expect(
      changeOwnPassword(actor, { current: INITIAL_PASSWORD, next: "brand-new-password-1" }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.RATE_LIMITED);
  });

  it("success clears mustChangePassword, rotates the password hash, bumps sessionVersion, and audits without password material", async () => {
    const { tenantId, userId, actor } = await mkUser();

    await changeOwnPassword(actor, { current: INITIAL_PASSWORD, next: "brand-new-password-1" });

    const row = await owner.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.mustChangePassword).toBe(false);
    expect(row.sessionVersion).toBe(1);
    expect(await verifyPassword(row.passwordHash, "brand-new-password-1")).toBe(true);
    expect(await verifyPassword(row.passwordHash, INITIAL_PASSWORD)).toBe(false);

    const auditRow = await owner.auditLog.findFirst({
      where: { tenantId, actorId: userId, action: "auth.changePassword" },
      orderBy: { id: "desc" },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow?.before).toBeFalsy();
    expect(auditRow?.after).toBeFalsy();

    const event = await owner.domainEvent.findFirst({
      where: { tenantId, aggregateType: "User", aggregateId: String(userId), type: "PasswordChanged" },
    });
    expect(event).toBeTruthy();
  });

  it("bumps sessionVersion so a second session's token is rejected by getActor(), while the current cookie keeps working (proves the OLD token is actually refused)", async () => {
    const { userId, tenantId, actor } = await mkUser();

    // Device B logs in first (sessionVersion 0) — capture its raw signed
    // cookie value before Device A changes the password.
    cookieValue = undefined;
    await createSession({ userId, tenantId, clientId: null, sessionVersion: 0 });
    const deviceBToken = cookieValue;
    expect(deviceBToken).toBeTruthy();

    // Device A is a separate browser, also still at sessionVersion 0.
    await createSession({ userId, tenantId, clientId: null, sessionVersion: 0 });

    // Device A changes the password — internally re-issues the CURRENT
    // (mock) cookie slot with the bumped sessionVersion.
    await changeOwnPassword(actor, { current: INITIAL_PASSWORD, next: "brand-new-password-1" });

    // Device A's just-refreshed cookie keeps working — the user is not
    // logged out by their own change.
    const actorA = await getActor();
    expect(actorA).not.toBeNull();
    expect(actorA?.userId).toBe(userId);
    expect(actorA?.mustChangePassword).toBe(false);

    // Swap in Device B's stale (pre-change) token. getActor() must now
    // refuse it — the actual proof that the OLD token stops working, not
    // just that the DB row changed.
    cookieValue = deviceBToken;
    const actorB = await getActor();
    expect(actorB).toBeNull();
  });
});
