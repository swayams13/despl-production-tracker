"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { recordMtc } from "@/lib/services/mtc.service";
import { recordProcurementEvent } from "@/lib/services/procurement.service";
import { toActionError, type ActionResult } from "./_action";

export async function recordMtcAction(
  jobId: number,
  bomItemId: number,
  heatNumber: string,
  pmiResult: "NA" | "PENDING" | "ACCEPT" | "REJECT",
  mtcRef?: string,
): Promise<ActionResult> {
  try {
    await recordMtc(await requireActor(), { bomItemId, heatNumber, mtcRef, pmiResult });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordProcurementEventAction(
  jobId: number,
  bomItemId: number,
  type: "INDENT_RAISED" | "INDENT_APPROVED" | "PO_PLACED" | "RECEIPT",
  qty?: number,
  refNo?: string,
): Promise<ActionResult> {
  try {
    await recordProcurementEvent(await requireActor(), { bomItemId, type, qty, refNo });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
