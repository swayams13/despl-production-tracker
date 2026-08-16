"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { claimPlan, assignPlan, releasePlan } from "@/lib/services/assignment.service";
import { toActionError, type ActionResult } from "./_action";

export async function claimPlanAction(processPlanId: number): Promise<ActionResult> {
  try {
    await claimPlan(await requireActor(), { processPlanId });
    revalidatePath("/workspace");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function assignPlanAction(processPlanId: number, userId: number): Promise<ActionResult> {
  try {
    await assignPlan(await requireActor(), { processPlanId, userId });
    revalidatePath("/workspace");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function releasePlanAction(processPlanId: number): Promise<ActionResult> {
  try {
    await releasePlan(await requireActor(), { processPlanId });
    revalidatePath("/workspace");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
