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

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    identifier: formData.get("identifier"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter your username or email and password" };
  }
  const { identifier, password } = parsed.data;

  // Same generic message for unknown tenant, unknown user, inactive user and
  // wrong password — never reveal which accounts exist.
  const invalid: LoginState = { error: "Incorrect username, email, or password" };

  // resolveTenantForLogin ignores its input (single-tenant, resolves by a
  // fixed org code — see that file's doc comment), so widening the
  // identifier to username-or-email needs no change here.
  const tenantId = await resolveTenantForLogin(identifier);
  if (tenantId === null) return invalid;

  const session = await withTenant(tenantId, async (tx) => {
    // D13 (SPEC §3): login identifier is username OR email. Email lookups stay
    // lowercased to match how email is always stored (createUser/createEmployee
    // both lowercase it); username is matched as typed since createEmployee's
    // username is stored verbatim, case included.
    const user = await tx.user.findFirst({
      where: {
        active: true,
        OR: [{ email: identifier.toLowerCase() }, { username: identifier }],
      },
    });
    if (!user) return null;
    if (!(await verifyPassword(user.passwordHash, password))) return null;
    return {
      userId: user.id,
      tenantId: user.tenantId,
      clientId: user.clientId,
      sessionVersion: user.sessionVersion,
    };
  });

  if (!session) return invalid;

  await createSession(session);
  redirect(session.clientId === null ? "/" : "/portal");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}
