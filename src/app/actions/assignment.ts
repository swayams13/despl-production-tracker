"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { claimPlan, assignPlan, assignPlans, releasePlan, type AssignBulkResult } from "@/lib/services/assignment.service";
import { claimNext } from "@/lib/services/today.service";
import { toActionError, type ActionResult } from "./_action";

export async function claimPlanAction(processPlanId: number): Promise<ActionResult> {
  try {
    await claimPlan(await requireActor(), { processPlanId });
    revalidatePath("/workspace");
    revalidatePath("/my-day");
    revalidatePath("/today");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function assignPlanAction(processPlanId: number, userId: number): Promise<ActionResult> {
  try {
    await assignPlan(await requireActor(), { processPlanId, userId });
    revalidatePath("/workspace");
    revalidatePath("/my-day");
    revalidatePath("/today");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function releasePlanAction(processPlanId: number): Promise<ActionResult> {
  try {
    await releasePlan(await requireActor(), { processPlanId });
    revalidatePath("/workspace");
    revalidatePath("/my-day");
    revalidatePath("/today");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/** L2.3: an operator's one-tap "Claim next" on Today. */
export async function claimNextAction(): Promise<ActionResult> {
  try {
    await claimNext(await requireActor());
    revalidatePath("/today");
    revalidatePath("/my-day");
    revalidatePath("/workspace");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/** L2.5: assign several pool items to one person. Partial success is reported, never hidden. */
export async function assignPlansAction(
  processPlanIds: number[],
  userId: number,
): Promise<{ ok: true; result: AssignBulkResult } | Exclude<ActionResult, { ok: true }>> {
  try {
    const result = await assignPlans(await requireActor(), { processPlanIds, userId });
    for (const p of ["/team", "/today", "/my-day", "/workspace"]) revalidatePath(p);
    return { ok: true, result };
  } catch (e) {
    return toActionError(e) as Exclude<ActionResult, { ok: true }>;
  }
}
