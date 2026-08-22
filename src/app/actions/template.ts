"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import {
  createTemplate,
  cloneVersion,
  saveDraftVersion,
  publishVersion,
  type TemplateWarning,
} from "@/lib/services/template.service";
import { isAppError } from "@/lib/shared/errors";
import { toActionError, type ActionResult } from "./_action";
import type {
  CreateTemplateInput,
  CloneVersionInput,
  SaveDraftVersionInput,
  PublishVersionInput,
} from "@/lib/shared/schemas";

export type CreateVersionResult = ActionResult & { versionId?: number };

export async function createTemplateAction(input: CreateTemplateInput): Promise<CreateVersionResult> {
  try {
    const v = await createTemplate(await requireActor(), input);
    revalidatePath("/admin/templates");
    return { ok: true, versionId: v.id };
  } catch (e) {
    return toActionError(e);
  }
}

export async function cloneVersionAction(input: CloneVersionInput): Promise<CreateVersionResult> {
  try {
    const v = await cloneVersion(await requireActor(), input);
    revalidatePath("/admin/templates");
    return { ok: true, versionId: v.id };
  } catch (e) {
    return toActionError(e);
  }
}

/** The refusal detail matters here — the editor prints which process is at fault. */
export type SaveDraftResult = ActionResult & { updatedAt?: string; detail?: Record<string, unknown> };

export async function saveDraftVersionAction(input: SaveDraftVersionInput): Promise<SaveDraftResult> {
  try {
    const v = await saveDraftVersion(await requireActor(), input);
    revalidatePath(`/admin/templates/${input.versionId}`);
    return { ok: true, updatedAt: v.updatedAt?.toISOString() };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && isAppError(e)) return { ...result, detail: e.detail };
    return result;
  }
}

export type PublishResultAction = ActionResult & {
  warnings?: TemplateWarning[];
  envelopeDays?: number | null;
  detail?: Record<string, unknown>;
};

export async function publishVersionAction(input: PublishVersionInput): Promise<PublishResultAction> {
  try {
    const r = await publishVersion(await requireActor(), input);
    revalidatePath("/admin/templates");
    revalidatePath(`/admin/templates/${input.versionId}`);
    return { ok: true, warnings: r.warnings, envelopeDays: r.envelopeDays };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && isAppError(e)) return { ...result, detail: e.detail };
    return result;
  }
}
