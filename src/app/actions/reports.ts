"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { publishDigest } from "@/lib/services/reports.service";
import { toActionError, type ActionResult } from "./_action";

export async function sendDigestAction(date: string): Promise<ActionResult & { recipients?: number }> {
  try {
    const recipients = await publishDigest(await requireActor(), date);
    revalidatePath("/reports");
    return { ok: true, recipients };
  } catch (e) {
    return toActionError(e);
  }
}
