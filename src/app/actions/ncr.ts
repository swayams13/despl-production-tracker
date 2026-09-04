"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { dispositionNcr } from "@/lib/services/ncr.service";
import { toActionError, type ActionResult } from "./_action";

/**
 * closeNcr (ncr.service.ts) is deliberately NOT exposed here. Its own comment
 * says why: it takes an already-open `tx` rather than opening its own, and
 * its `ncrId` lookup carries no tenant filter — safe today only because its
 * two callers (verifyComponentOperation, verifyAssemblyStep) already
 * tenant-scoped the operation/step before finding the ncrId. Exposing it from
 * a Server Action means a client-supplied ncrId reaching that unscoped
 * lookup directly, which needs a real tenant filter added first — that's new
 * service-layer logic, not a thin wrapper, so it's out of scope here.
 */
export async function dispositionNcrAction(
  ncrId: number,
  disposition: "USE_AS_IS" | "REPAIR" | "REWORK" | "SCRAP" | "CONCESSION",
  detail?: {
    notes?: string;
    reworkOwnerId?: number;
    reworkDueDate?: Date;
  },
): Promise<ActionResult> {
  try {
    await dispositionNcr(await requireActor(), { ncrId, disposition, ...detail });
    revalidatePath("/workspace");
    revalidatePath("/qc");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
