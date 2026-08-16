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
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter your email and password" };
  }
  const { email, password } = parsed.data;

  // Same generic message for unknown tenant, unknown user, inactive user and
  // wrong password — never reveal which accounts exist.
  const invalid: LoginState = { error: "Email or password is incorrect" };

  const tenantId = await resolveTenantForLogin(email);
  if (tenantId === null) return invalid;

  const session = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { email, active: true } });
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
