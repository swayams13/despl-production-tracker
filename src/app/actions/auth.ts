"use server";

import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession } from "@/lib/auth/session";
import { resolveTenantForLogin } from "@/lib/auth/tenant-resolution";
import { loginSchema } from "@/lib/shared/schemas";

export interface LoginState {
  error?: string;
}

/** Failed-attempt window (audit C4). Same shape as changeOwnPassword's rate
 * limit (lib/auth/change-password.ts) but keyed on the raw identifier, not a
 * userId — pre-auth, an unknown/wrong identifier never resolves to one. */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    identifier: formData.get("identifier"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter your username or email and password" };
  }
  const { identifier, password } = parsed.data;
  const identifierKey = identifier.toLowerCase();

  // Same generic message for unknown tenant, unknown user, inactive user and
  // wrong password — never reveal which accounts exist.
  const invalid: LoginState = { error: "Incorrect username, email, or password" };
  const rateLimited: LoginState = { error: "Too many attempts. Try again in a few minutes." };

  // resolveTenantForLogin ignores its input (single-tenant, resolves by a
  // fixed org code — see that file's doc comment), so widening the
  // identifier to username-or-email needs no change here.
  const tenantId = await resolveTenantForLogin(identifier);
  if (tenantId === null) return invalid;

  const { session, rateLimitedNow } = await withTenant(tenantId, async (tx) => {
    // Audit C4: brute force was unthrottled AND left no trace at all — the
    // pattern already exists for changeOwnPassword, just never applied here.
    // Keyed on the identifier attempted (entityId), since a userId isn't
    // known yet for an unknown/wrong identifier.
    const recentFailures = await tx.auditLog.count({
      where: {
        tenantId,
        action: "auth.loginFailed",
        entityId: identifierKey,
        at: { gte: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) },
      },
    });
    if (recentFailures >= RATE_LIMIT_MAX_ATTEMPTS) {
      return { session: null, rateLimitedNow: true };
    }

    // D13 (SPEC §3): login identifier is username OR email. Both lookups are
    // lowercased to match how both are stored (createEmployeeSchema now
    // lowercases `username` the same way `email` always has) — case alone
    // must never make an identifier match two different rows.
    const user = await tx.user.findFirst({
      where: { active: true, OR: [{ email: identifierKey }, { username: identifierKey }] },
    });
    const verified = user ? await verifyPassword(user.passwordHash, password) : false;
    if (!user || !verified) {
      await tx.auditLog.create({
        data: { tenantId, actorId: user?.id ?? null, action: "auth.loginFailed", entityType: "User", entityId: identifierKey },
      });
      return { session: null, rateLimitedNow: false };
    }
    // Server clock only (invariant #1) — feeds /admin's "Last login" column
    // (SPEC §7.3). Not audited/domain-evented: this is login infrastructure
    // bookkeeping, not a business-record mutation, matching how sessionVersion
    // itself is written outside the audit path everywhere except admin resets.
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return {
      session: {
        userId: user.id,
        tenantId: user.tenantId,
        clientId: user.clientId,
        sessionVersion: user.sessionVersion,
      },
      rateLimitedNow: false,
    };
  });

  if (rateLimitedNow) return rateLimited;
  if (!session) return invalid;

  await createSession(session);
  redirect(session.clientId === null ? "/" : "/portal");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}
