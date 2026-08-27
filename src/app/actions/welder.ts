"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { createWelder, updateWelder } from "@/lib/services/welder.service";
import { toActionError, type ActionResult } from "./_action";

export async function createWelderAction(input: {
  name: string;
  employeeCode: string;
  departmentId?: number | null;
}): Promise<ActionResult> {
  try {
    await createWelder(await requireActor(), { ...input, departmentId: input.departmentId ?? null });
    revalidatePath("/welding");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateWelderAction(input: {
  id: number;
  name?: string;
  employeeCode?: string;
  departmentId?: number | null;
  active?: boolean;
}): Promise<ActionResult> {
  try {
    await updateWelder(await requireActor(), input);
    revalidatePath("/welding");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
