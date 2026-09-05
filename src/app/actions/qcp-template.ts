"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { createQcpTemplateLibrary, addQcpItemToLibraryTemplate } from "@/lib/services/qcp.service";
import { toActionError, type ActionResult } from "./_action";
import type { CreateQcpTemplateLibraryInput, AddQcpItemToLibraryTemplateInput } from "@/lib/shared/schemas";

export type CreateQcpTemplateLibraryResult = ActionResult & { qcpTemplateId?: number };

export async function createQcpTemplateLibraryAction(
  input: CreateQcpTemplateLibraryInput,
): Promise<CreateQcpTemplateLibraryResult> {
  try {
    const created = await createQcpTemplateLibrary(await requireActor(), input);
    revalidatePath("/admin/qcp-templates");
    return { ok: true, qcpTemplateId: created.id };
  } catch (e) {
    return toActionError(e);
  }
}

export type AddQcpItemToLibraryTemplateResult = ActionResult & { qcpItemId?: number };

export async function addQcpItemToLibraryTemplateAction(
  input: AddQcpItemToLibraryTemplateInput,
): Promise<AddQcpItemToLibraryTemplateResult> {
  try {
    const created = await addQcpItemToLibraryTemplate(await requireActor(), input);
    revalidatePath("/admin/qcp-templates");
    return { ok: true, qcpItemId: created.id };
  } catch (e) {
    return toActionError(e);
  }
}
