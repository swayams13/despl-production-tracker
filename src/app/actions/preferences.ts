"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { setOwnThemePreference } from "@/lib/auth/preferences";
import { ERROR_CODES, ERROR_MESSAGES } from "@/lib/shared/errors";
import { toActionError, type ActionResult } from "./_action";

const themeStateSchema = z.object({
  themePreference: z.enum(["SYSTEM", "LIGHT", "DARK"]),
  outdoorMode: z.boolean(),
});

/**
 * Save the caller's own appearance preference. Thin caller per CLAUDE.md:
 * parse → resolve actor → call the small function → UI-safe result. The
 * client follows this with router.refresh(), so the layout re-renders with
 * the new theme class without a full page load; `revalidatePath("/", "layout")`
 * is what makes that refresh see the new actor (same shape as
 * markNotificationReadAction).
 */
export async function setThemeAction(input: z.input<typeof themeStateSchema>): Promise<ActionResult> {
  const parsed = themeStateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: ERROR_CODES.VALIDATION_FAILED, message: ERROR_MESSAGES.VALIDATION_FAILED };
  }
  try {
    await setOwnThemePreference(await requireActor(), parsed.data);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
