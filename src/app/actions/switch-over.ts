"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActor } from "@/lib/authz";
import { applySwitchOver, type SwitchOverResult } from "@/lib/services/switch-over.service";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { FEATURES } from "@/lib/shared/flags";
import { toActionError, type ActionResult } from "./_action";

/**
 * Lean Core L2.10 part B. A thin caller of switch-over.service, which writes only
 * through recordWork; off with the lean floor (LEAN_FLOOR unset) like recordWork's own actions.
 */
const schema = z
  .object({
    jobId: z.number().int().positive(),
    doneAt: z.iso.datetime({ offset: true }),
    lateCategoryId: z.number().int().positive().optional(),
    items: z.array(z.object({ kind: z.enum(["COMPONENT_OP", "ASSEMBLY_STEP", "PROCESS_PLAN"]), id: z.number().int().positive() }).strict()).min(1).max(5000),
  })
  .strict();

export type ApplySwitchOverResult = ActionResult & { result?: SwitchOverResult };

export async function applySwitchOverAction(input: z.input<typeof schema>): Promise<ApplySwitchOverResult> {
  try {
    if (!FEATURES.leanFloor) throw new AppError(ERROR_CODES.FEATURE_FROZEN, { feature: "leanFloor" });
    const parsed = schema.parse(input);
    const result = await applySwitchOver(await requireActor(), parsed);
    for (const path of [`/jobs/${parsed.jobId}`, `/jobs/${parsed.jobId}/switch-over`, "/workspace", "/dashboard", "/my-day", "/today", "/qc"]) revalidatePath(path);
    return { ok: true, result };
  } catch (e) {
    return toActionError(e);
  }
}
