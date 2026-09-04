"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import {
  createDispatchBatch,
  addUnitToBatch,
  approveDispatchRelease,
  recordDispatch,
} from "@/lib/services/dispatch.service";
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

export async function createDispatchBatchAction(
  jobId: number,
  seq: number,
  plannedDate: Date,
  remarks?: string,
): Promise<ActionResult> {
  return run(jobId, async () => createDispatchBatch(await requireActor(), { jobId, seq, plannedDate, remarks }));
}

export async function addUnitToBatchAction(
  jobId: number,
  dispatchBatchId: number,
  unitId: number,
): Promise<ActionResult> {
  return run(jobId, async () => addUnitToBatch(await requireActor(), { dispatchBatchId, unitId }));
}

export async function approveDispatchReleaseAction(
  jobId: number,
  dispatchBatchId: number,
  detail?: {
    dispatchNoteNo?: string;
    gatePassNo?: string;
    vehicleNo?: string;
    lrNo?: string;
  },
): Promise<ActionResult> {
  return run(jobId, async () =>
    approveDispatchRelease(await requireActor(), { dispatchBatchId, ...detail }),
  );
}

export async function recordDispatchAction(jobId: number, dispatchBatchId: number): Promise<ActionResult> {
  return run(jobId, async () => recordDispatch(await requireActor(), { dispatchBatchId }));
}
