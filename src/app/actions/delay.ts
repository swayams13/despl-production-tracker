"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { fileDelayReason } from "@/lib/services/delay.service";
import { toActionError, type ActionResult } from "./_action";

export async function fileDelayAction(
  processPlanId: number,
  categoryId: number,
  detail?: string,
): Promise<ActionResult> {
  try {
    await fileDelayReason(await requireActor(), { processPlanId, categoryId, detail });
    revalidatePath("/workspace");
    revalidatePath("/my-day");
    revalidatePath("/board");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * File one categorised reason across many plans — the workspace "Apply reason
 * to all overdue" bulk action (§4.4). Each plan still routes through the same
 * `fileDelayReason` service (its own gate + audit row); a per-plan failure
 * doesn't roll back the others, so the result reports how many landed.
 */
export async function fileDelayBulkAction(
  processPlanIds: number[],
  categoryId: number,
  detail?: string,
): Promise<ActionResult & { filed?: number }> {
  const actor = await requireActor();
  let filed = 0;
  let firstError: ActionResult | null = null;
  for (const processPlanId of processPlanIds) {
    try {
      await fileDelayReason(actor, { processPlanId, categoryId, detail });
      filed++;
    } catch (e) {
      const err = toActionError(e);
      if (!err.ok && !firstError) firstError = err;
    }
  }
  revalidatePath("/workspace");
  revalidatePath("/dashboard");
  revalidatePath("/my-day");
  revalidatePath("/board");
  if (firstError && filed === 0) return firstError;
  return { ok: true, filed };
}
