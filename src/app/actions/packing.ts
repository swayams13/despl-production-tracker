"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { createPackage, assignUnitToPackage } from "@/lib/services/packing.service";
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

export async function createPackageAction(
  jobId: number,
  packageNo: string,
  detail?: {
    weightKg?: number;
    lengthMm?: number;
    widthMm?: number;
    heightMm?: number;
    preservationNotes?: string;
  },
): Promise<ActionResult> {
  return run(jobId, async () => createPackage(await requireActor(), { jobId, packageNo, ...detail }));
}

export async function assignUnitToPackageAction(
  jobId: number,
  packageId: number,
  unitId: number,
): Promise<ActionResult> {
  return run(jobId, async () => assignUnitToPackage(await requireActor(), { packageId, unitId }));
}
