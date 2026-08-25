"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import * as svc from "@/lib/services/component.service";
import { toActionError, type ActionResult } from "./_action";

async function run(jobId: number, fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function startComponentOperationAction(
  jobId: number,
  componentOperationId: number,
): Promise<ActionResult> {
  return run(jobId, async () => svc.startComponentOperation(await requireActor(), { componentOperationId }));
}
export async function submitComponentOperationAction(
  jobId: number,
  componentOperationId: number,
): Promise<ActionResult> {
  return run(jobId, async () => svc.submitComponentOperation(await requireActor(), { componentOperationId }));
}
export async function verifyComponentOperationAction(
  jobId: number,
  componentOperationId: number,
): Promise<ActionResult> {
  return run(jobId, async () => svc.verifyComponentOperation(await requireActor(), { componentOperationId }));
}
