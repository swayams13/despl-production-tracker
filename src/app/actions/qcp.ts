"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { recordQcpExecution, approveQcpWaiver } from "@/lib/services/qcp.service";
import { toActionError, type ActionResult } from "./_action";

export async function recordQcpAction(
  qcpItemId: number,
  unitId: number,
  result: "ACCEPTED" | "REJECTED" | "NA",
  remarks?: string,
): Promise<ActionResult> {
  try {
    await recordQcpExecution(await requireActor(), { qcpItemId, unitId, result, remarks });
    revalidatePath("/workspace");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/** AUD-003: Production Head/Admin signs off a pending NA waiver. */
export async function approveQcpWaiverAction(qcpItemId: number, unitId: number): Promise<ActionResult> {
  try {
    await approveQcpWaiver(await requireActor(), { qcpItemId, unitId });
    revalidatePath("/workspace");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
