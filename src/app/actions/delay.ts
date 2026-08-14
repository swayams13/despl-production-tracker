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
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
