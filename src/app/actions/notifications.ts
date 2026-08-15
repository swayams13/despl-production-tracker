"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { markNotificationRead, markAllNotificationsRead } from "@/lib/services/notifications.service";
import { toActionError, type ActionResult } from "./_action";

export async function markNotificationReadAction(id: number): Promise<ActionResult> {
  try {
    await markNotificationRead(await requireActor(), id);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function markAllNotificationsReadAction(): Promise<ActionResult> {
  try {
    await markAllNotificationsRead(await requireActor());
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
