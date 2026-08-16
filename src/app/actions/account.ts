"use server";

import { redirect } from "next/navigation";
import { requireActor } from "@/lib/authz";
import { changeOwnPassword } from "@/lib/auth/change-password";
import { changePasswordSchema } from "@/lib/shared/schemas";
import { isAppError, ERROR_MESSAGES } from "@/lib/shared/errors";

export interface ChangePasswordState {
  error?: string;
}

/**
 * First-login (and any-time) password change. Thin caller per CLAUDE.md
 * conventions: parse → requireActor → service call → map AppError to a
 * UI-safe message. On success, redirect to "/" — the role-based landing
 * router resolves where the now-unlocked user lands.
 */
export async function changePassword(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const parsed = changePasswordSchema.safeParse({
    current: formData.get("current"),
    next: formData.get("next"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter your current and new password" };
  }

  try {
    const actor = await requireActor();
    await changeOwnPassword(actor, parsed.data);
  } catch (e) {
    if (isAppError(e)) {
      return { error: ERROR_MESSAGES[e.code] ?? "Could not change your password." };
    }
    throw e;
  }

  redirect("/");
}
