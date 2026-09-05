"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { createOrReviseRouteTemplate, setOperationRefFamilySeq } from "@/lib/services/route.service";
import { toActionError, type ActionResult } from "./_action";
import type { CreateOrReviseRouteTemplateInput, SetOperationRefFamilySeqInput } from "@/lib/shared/schemas";

export type CreateOrReviseRouteTemplateResult = ActionResult & { versionId?: number };

export async function createOrReviseRouteTemplateAction(
  input: CreateOrReviseRouteTemplateInput,
): Promise<CreateOrReviseRouteTemplateResult> {
  try {
    const v = await createOrReviseRouteTemplate(await requireActor(), input);
    revalidatePath("/admin/routes");
    return { ok: true, versionId: v.id };
  } catch (e) {
    return toActionError(e);
  }
}

export async function setOperationRefFamilySeqAction(
  input: SetOperationRefFamilySeqInput,
): Promise<ActionResult> {
  try {
    await setOperationRefFamilySeq(await requireActor(), input);
    revalidatePath("/admin/routes");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
