"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import * as svc from "@/lib/services/client-snapshot.service";
import { toActionError, type ActionResult } from "./_action";

async function run(jobId: number, fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/portal");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function publishSnapshotAction(jobId: number): Promise<ActionResult> {
  return run(jobId, async () => svc.publishSnapshot(await requireActor(), { jobId }));
}

export async function verifySnapshotAction(jobId: number): Promise<ActionResult> {
  return run(jobId, async () => svc.verifySnapshot(await requireActor(), { jobId }));
}

export async function rejectSnapshotAction(jobId: number, reason: string): Promise<ActionResult> {
  return run(jobId, async () => svc.rejectSnapshot(await requireActor(), { jobId, reason }));
}
