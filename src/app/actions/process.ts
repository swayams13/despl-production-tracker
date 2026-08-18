"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import * as svc from "@/lib/services/process.service";
import { toActionError, type ActionResult } from "./_action";

async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath("/workspace");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function startAction(processPlanId: number): Promise<ActionResult> {
  return run(async () => svc.startProcess(await requireActor(), { processPlanId }));
}
export async function submitAction(processPlanId: number): Promise<ActionResult> {
  return run(async () => svc.submitProcess(await requireActor(), { processPlanId }));
}
export async function verifyAction(processPlanId: number): Promise<ActionResult> {
  return run(async () => svc.verifyProcess(await requireActor(), { processPlanId }));
}
export async function rejectAction(processPlanId: number, reason: string): Promise<ActionResult> {
  return run(async () => svc.rejectProcess(await requireActor(), { processPlanId, reason }));
}
export async function holdAction(processPlanId: number, reason: string): Promise<ActionResult> {
  return run(async () => svc.holdProcess(await requireActor(), { processPlanId, reason }));
}
export async function resumeAction(processPlanId: number): Promise<ActionResult> {
  return run(async () => svc.resumeProcess(await requireActor(), { processPlanId }));
}

/**
 * Start many plans — the workspace "Start all" bulk action (§4.4). Each still
 * routes through `startProcess` (its own gate + audit); gate-blocked or
 * reason-required plans are skipped, and the result reports how many started so
 * a partially-startable card gives honest feedback rather than an all-or-nothing.
 */
export async function startBulkAction(
  processPlanIds: number[],
): Promise<ActionResult & { started?: number }> {
  const actor = await requireActor();
  let started = 0;
  let firstError: ActionResult | null = null;
  for (const processPlanId of processPlanIds) {
    try {
      await svc.startProcess(actor, { processPlanId });
      started++;
    } catch (e) {
      const err = toActionError(e);
      if (!err.ok && !firstError) firstError = err;
    }
  }
  revalidatePath("/workspace");
  revalidatePath("/dashboard");
  revalidatePath("/my-day");
  revalidatePath("/board");
  if (firstError && started === 0) return firstError;
  return { ok: true, started };
}
