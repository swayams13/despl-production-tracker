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
export async function holdAction(processPlanId: number, reason: string): Promise<ActionResult> {
  return run(async () => svc.holdProcess(await requireActor(), { processPlanId, reason }));
}
export async function resumeAction(processPlanId: number): Promise<ActionResult> {
  return run(async () => svc.resumeProcess(await requireActor(), { processPlanId }));
}
