"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { acknowledgeOverride } from "@/lib/services/override-ack.service";
import { toActionError, type ActionResult } from "./_action";

/** D2: one-tap Acknowledge of an out-of-sequence start (Production Head only; the service checks). */
export async function acknowledgeOverrideAction(overrideId: number): Promise<ActionResult> {
  try {
    await acknowledgeOverride(await requireActor(), { overrideId });
    revalidatePath("/team", "layout");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
