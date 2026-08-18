import { beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * The forced-password-change lock (final-review Finding 1).
 *
 * Page-level redirects only stop a browser RENDERING a screen. The lock that
 * matters lives in `requireActor()` — the single entry point every server
 * action and every `/api` route uses to obtain an actor it may act as. Without
 * it, an admin holding a printed temp-password slip can drive every mutation
 * as that employee, with the audit trail naming the employee.
 *
 * `getActor()`'s two dependencies (the signed session cookie and the tenant-
 * scoped user read) are stubbed so these tests exercise the guard itself, not
 * session/Prisma plumbing — the live cookie + DB round-trip is covered by
 * change-password.test.ts's DB-gated suite.
 */

const state = vi.hoisted(() => ({
  user: null as null | {
    id: number;
    tenantId: number;
    clientId: number | null;
    name: string;
    email: string;
    sessionVersion: number;
    mustChangePassword: boolean;
    themePreference: "SYSTEM" | "LIGHT" | "DARK";
    outdoorMode: boolean;
    roles: { role: { code: string } }[];
    departments: { departmentId: number }[];
  },
}));

vi.mock("@/lib/auth/session", () => ({
  readSession: async () =>
    state.user
      ? {
          userId: state.user.id,
          tenantId: state.user.tenantId,
          clientId: state.user.clientId,
          sessionVersion: state.user.sessionVersion,
        }
      : null,
}));

vi.mock("@/lib/db", () => ({
  withTenant: async <T>(_tenantId: number, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ user: { findFirst: async () => state.user } }),
}));

function seedUser(over: { mustChangePassword?: boolean } = {}) {
  state.user = {
    id: 7,
    tenantId: 1,
    clientId: null,
    name: "Locked User",
    email: "locked@despl.local",
    sessionVersion: 0,
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
    roles: [{ role: { code: "SUPERVISOR" } }],
    departments: [{ departmentId: 3 }],
    ...over,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return isAppError(e) ? e.code : "NOT_AN_APP_ERROR";
  }
}

beforeEach(() => {
  state.user = null;
  vi.clearAllMocks();
});

describe("requireActor — a user who owes a forced password change may not act", () => {
  it("refuses with MUST_CHANGE_PASSWORD", async () => {
    const { requireActor } = await import("./index");
    seedUser({ mustChangePassword: true });
    expect(await codeOf(requireActor())).toBe(ERROR_CODES.MUST_CHANGE_PASSWORD);
  });

  it("allows a user who does not owe one", async () => {
    const { requireActor } = await import("./index");
    seedUser({ mustChangePassword: false });
    expect((await requireActor()).userId).toBe(7);
  });

  it("still refuses an unauthenticated caller with UNAUTHENTICATED, not the new code", async () => {
    const { requireActor } = await import("./index");
    state.user = null;
    expect(await codeOf(requireActor())).toBe(ERROR_CODES.UNAUTHENTICATED);
  });

  it("getActor() still returns the locked actor — the page guards need it to decide WHERE to redirect", async () => {
    const { getActor } = await import("./index");
    seedUser({ mustChangePassword: true });
    const actor = await getActor();
    expect(actor?.userId).toBe(7);
    expect(actor?.mustChangePassword).toBe(true);
  });

  it("MUST_CHANGE_PASSWORD's message carries no password material", async () => {
    const { ERROR_MESSAGES } = await import("@/lib/shared/errors");
    expect(ERROR_MESSAGES.MUST_CHANGE_PASSWORD).toBe(
      "Change your password before doing anything else.",
    );
  });
});

/**
 * The one exemption: the action that CLEARS the lock must still run for a
 * locked user, otherwise the flow deadlocks. It calls getActor() directly
 * rather than taking a bypass flag on the shared helper.
 */
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/change-password", () => ({ changeOwnPassword: vi.fn(async () => {}) }));

describe("changePassword action — the single exempt caller", () => {
  it("runs for a locked (mustChangePassword) actor instead of refusing it", async () => {
    const { changePassword } = await import("@/app/actions/account");
    const { changeOwnPassword } = await import("@/lib/auth/change-password");
    const { redirect } = await import("next/navigation");
    seedUser({ mustChangePassword: true });

    const form = new FormData();
    form.set("current", "temp-password-1");
    form.set("next", "brand-new-password-1");
    await changePassword({}, form);

    expect(changeOwnPassword).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, mustChangePassword: true }),
      { current: "temp-password-1", next: "brand-new-password-1" },
    );
    expect(redirect).toHaveBeenCalledWith("/");
  });

  it("still refuses an unauthenticated caller", async () => {
    const { changePassword } = await import("@/app/actions/account");
    const { changeOwnPassword } = await import("@/lib/auth/change-password");
    state.user = null;

    const form = new FormData();
    form.set("current", "temp-password-1");
    form.set("next", "brand-new-password-1");
    expect(await changePassword({}, form)).toEqual({ error: "Please sign in." });
    expect(changeOwnPassword).not.toHaveBeenCalled();
  });
});
