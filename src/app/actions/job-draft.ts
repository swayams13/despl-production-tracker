"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { saveDraft, copyJobToDraft, releaseDraft, discardDraft, type JobDraftView } from "@/lib/services/job-draft.service";
import { previewJob, type JobPreview } from "@/lib/services/job-preview.service";
import type { CreateJobResult } from "@/lib/services/job-intake.service";
import type { CreateJobInput } from "@/lib/shared/schemas";
import { isAppError } from "@/lib/shared/errors";
import { toActionError, type ActionResult } from "./_action";

// J7a: thin callers; the rules live in job-draft.service.ts and job-preview.service.ts.
// ponytail: no screen yet (J7b builds the wizard on these); the actions exist so the service has one door.

export type DraftActionResult = ActionResult & { draft?: JobDraftView; detail?: Record<string, unknown> };

function fail(e: unknown): DraftActionResult {
  const r = toActionError(e);
  return !r.ok && isAppError(e) ? { ...r, detail: e.detail } : r;
}

export async function previewJobAction(input: CreateJobInput): Promise<ActionResult & { preview?: JobPreview }> {
  try {
    return { ok: true, preview: await previewJob(await requireActor(), input) };
  } catch (e) {
    return fail(e);
  }
}

export async function saveDraftAction(draftId: number | undefined, payload: unknown): Promise<DraftActionResult> {
  try {
    const draft = await saveDraft(await requireActor(), { draftId, payload });
    return { ok: true, draft };
  } catch (e) {
    return fail(e);
  }
}

export async function copyJobToDraftAction(jobId: number): Promise<DraftActionResult> {
  try {
    return { ok: true, draft: await copyJobToDraft(await requireActor(), { jobId }) };
  } catch (e) {
    return fail(e);
  }
}

export async function releaseDraftAction(draftId: number): Promise<DraftActionResult & { job?: CreateJobResult }> {
  try {
    const { job } = await releaseDraft(await requireActor(), { draftId });
    revalidatePath("/jobs");
    return { ok: true, job };
  } catch (e) {
    return fail(e);
  }
}

export async function discardDraftAction(draftId: number): Promise<DraftActionResult> {
  try {
    return { ok: true, draft: await discardDraft(await requireActor(), { draftId }) };
  } catch (e) {
    return fail(e);
  }
}
