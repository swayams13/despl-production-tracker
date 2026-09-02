"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import * as svc from "@/lib/services/assembly.service";
import { toActionError, type ActionResult } from "./_action";

async function run(jobId: number, fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/welding");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function startAssemblyStepAction(jobId: number, assemblyStepId: number): Promise<ActionResult> {
  return run(jobId, async () => svc.startAssemblyStep(await requireActor(), { assemblyStepId }));
}

export async function submitAssemblyStepAction(
  jobId: number,
  assemblyStepId: number,
  detail?: {
    performedByWelderId?: number | null;
    performedByUserId?: number | null;
    remarks?: string;
    weldJointId?: number;
    newJoint?: {
      jointNo: string;
      jointType: string;
      weldSize?: string;
      wpsRef?: string;
      welderIds: number[];
    };
  },
): Promise<ActionResult> {
  return run(jobId, async () => svc.submitAssemblyStep(await requireActor(), { assemblyStepId, ...detail }));
}

export async function verifyAssemblyStepAction(jobId: number, assemblyStepId: number): Promise<ActionResult> {
  return run(jobId, async () => svc.verifyAssemblyStep(await requireActor(), { assemblyStepId }));
}

export async function rejectAssemblyStepAction(
  jobId: number,
  assemblyStepId: number,
  categoryId: number,
  detail?: string,
  testTypeId?: number,
): Promise<ActionResult> {
  return run(jobId, async () =>
    svc.rejectAssemblyStep(await requireActor(), { assemblyStepId, categoryId, detail, testTypeId }),
  );
}
