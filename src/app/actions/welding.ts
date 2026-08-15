"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { logWeldJoint, recordNdtResult } from "@/lib/services/welding.service";
import { toActionError, type ActionResult } from "./_action";

export async function logWeldJointAction(input: {
  jobId: number;
  unitId?: number;
  jointNo: string;
  jointType: string;
  weldSize?: string;
  wpsRef?: string;
  welderIds: number[];
}): Promise<ActionResult> {
  try {
    await logWeldJoint(await requireActor(), input);
    revalidatePath("/welding");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordNdtResultAction(
  weldJointId: number,
  testTypeId: number,
  result: "PENDING" | "ACCEPT" | "REJECT",
): Promise<ActionResult> {
  try {
    await recordNdtResult(await requireActor(), { weldJointId, testTypeId, result });
    revalidatePath("/welding");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
