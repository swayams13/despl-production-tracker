"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession } from "@/lib/auth/session";
import { resolveTenantForLogin } from "@/lib/auth/tenant-resolution";
import { loginSchema } from "@/lib/shared/schemas";
import { safeNext } from "@/lib/shared/safe-next";
import { clientIpFromForwardedFor, trustedProxyHops } from "@/lib/auth/client-ip";

export interface LoginState {
  error?: string;
}

/** Failed-attempt window (audit C4). Same shape as changeOwnPassword's rate
 * limit (lib/auth/change-password.ts) but keyed on the raw identifier, not a
 * userId — pre-auth, an unknown/wrong identifier never resolves to one.
 *
 * AUD-109: the count is per (identifier, client IP), so another address cannot
 * lock a named user out; a per-IP ceiling across all identifiers slows someone
 * spraying many usernames from one address; an account-wide ceiling (all IPs)
 * stops a distributed guess at one account without becoming the old lockout:
 * above the cap an attempt is refused only if the last failure was less than a
 * growing delay ago, so the real user gets back in within minutes. All the
 * numbers live here; adjust them here only. */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5; // per (identifier, IP)
const RATE_LIMIT_MAX_PER_IP = 30; // per IP, all identifiers
const RATE_LIMIT_MAX_PER_ACCOUNT = 25; // per identifier, all IPs
const ACCOUNT_DELAY_STEP_MS = 15 * 1000; // delay after the cap: (failures over cap + 1) steps...
const ACCOUNT_DELAY_MAX_MS = 5 * 60 * 1000; // ...never more than this

/** Caller's address per TRUSTED_PROXY_HOPS (lib/auth/client-ip.ts); null when unknown. */
async function clientIp(): Promise<string | null> {
  try {
    return clientIpFromForwardedFor((await headers()).get("x-forwarded-for"), trustedProxyHops());
  } catch {
    return null; // no request scope (tests, scripts)
  }
}

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
  const ip = await clientIp();

  const { session, rateLimitedNow } = await withTenant(tenantId, async (tx) => {
    // Audit C4: brute force was unthrottled AND left no trace at all — the
    // pattern already exists for changeOwnPassword, just never applied here.
    // Keyed on the identifier attempted (entityId), since a userId isn't
    // known yet for an unknown/wrong identifier.
    const now = Date.now();
    const since = { gte: new Date(now - RATE_LIMIT_WINDOW_MS) };
    const base = { tenantId, action: "auth.loginFailed", at: since };
    const [byIdentifier, byIp, account] = await Promise.all([
      tx.auditLog.count({ where: { ...base, ip, entityId: identifierKey } }),
      // No address, no per-IP ceiling: everyone without one would share a single bucket.
      ip === null ? 0 : tx.auditLog.count({ where: { ...base, ip } }),
      tx.auditLog.aggregate({ where: { ...base, entityId: identifierKey }, _count: true, _max: { at: true } }),
    ]);
    // Progressive, not a lock: refused only while the last failure is newer than the delay.
    const overCap = account._count - RATE_LIMIT_MAX_PER_ACCOUNT;
    const accountDelayMs = overCap >= 0 ? Math.min(ACCOUNT_DELAY_MAX_MS, (overCap + 1) * ACCOUNT_DELAY_STEP_MS) : 0;
    const accountBlocked = accountDelayMs > 0 && account._max.at !== null && now - account._max.at.getTime() < accountDelayMs;
    if (byIdentifier >= RATE_LIMIT_MAX_ATTEMPTS || byIp >= RATE_LIMIT_MAX_PER_IP || accountBlocked) {
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
        data: { tenantId, actorId: user?.id ?? null, action: "auth.loginFailed", entityType: "User", entityId: identifierKey, ip },
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
  // L2.2: a QR scanned while signed out comes back to the unit. Client users
  // keep their own landing; `/` still applies the forced password change.
  redirect(session.clientId === null ? (safeNext(formData.get("next")) ?? "/") : "/portal");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}
