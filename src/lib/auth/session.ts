import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

const COOKIE = "despl_session";
const MAX_AGE_SECONDS = 60 * 60 * 12; // one working day

/**
 * The session carries identity ONLY — user, tenant, and (for client users) the
 * client they are scoped to. Roles and department scopes are deliberately NOT
 * in the token: they are loaded per request, so revoking a role or moving a
 * supervisor between departments takes effect immediately instead of at their
 * next login.
 */
export interface SessionPayload {
  userId: number;
  tenantId: number;
  clientId: number | null;
}

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error("AUTH_SECRET is missing or too short (need >= 32 chars)");
  }
  return new TextEncoder().encode(value);
}

export async function createSession(payload: SessionPayload): Promise<void> {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const { userId, tenantId, clientId } = payload as unknown as SessionPayload;
    if (typeof userId !== "number" || typeof tenantId !== "number") return null;
    return { userId, tenantId, clientId: clientId ?? null };
  } catch {
    // expired or tampered
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}
