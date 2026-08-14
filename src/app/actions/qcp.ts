"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { recordQcpExecution } from "@/lib/services/qcp.service";
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
