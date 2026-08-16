"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import {
  createUser,
  resetUserPassword,
  createDelayCategory,
  updateDelayCategory,
  updateStandardDurations,
} from "@/lib/services/admin.service";
import { toActionError, type ActionResult } from "./_action";
import type { CreateUserInput } from "@/lib/shared/schemas";

export async function createUserAction(input: CreateUserInput): Promise<ActionResult> {
  try {
    await createUser(await requireActor(), input);
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function resetPasswordAction(userId: number, password: string): Promise<ActionResult> {
  try {
    // tempPassword deliberately dropped here: this action wraps the
    // ADMIN-CHOSEN-password path from the existing /admin table UI, which
    // already has the plaintext in `password`. Task 4.2 wires the
    // generate-if-omitted path (and the credential-slip hand-off) through a
    // new action of its own.
    await resetUserPassword(await requireActor(), { userId, password });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function createDelayCategoryAction(name: string): Promise<ActionResult> {
  try {
    await createDelayCategory(await requireActor(), { name });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function toggleDelayCategoryAction(id: number, active: boolean): Promise<ActionResult> {
  try {
    await updateDelayCategory(await requireActor(), { id, active });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateStandardDurationsAction(
  templateVersionId: number,
  edits: { templateProcessId: number; durationMinDays: number; durationMaxDays: number }[],
  reason: string,
): Promise<ActionResult> {
  try {
    await updateStandardDurations(await requireActor(), { templateVersionId, edits, reason });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
