"use server";
import { requireActor } from "@/lib/authz";
import { saveDraft, copyJobToDraft, releaseDraft, discardDraft, type JobDraftView } from "@/lib/services/job-draft.service";
import { previewJob, type JobPreview } from "@/lib/services/job-preview.service";
import type { CreateJobResult } from "@/lib/services/job-intake.service";
import type { CreateJobInput } from "@/lib/shared/schemas";
import { toActionError, type ActionResult } from "./_action";

// J7a: thin callers; the rules live in job-draft.service.ts and job-preview.service.ts.
// ponytail: no screen yet (J7b builds the wizard on these); the actions exist so the service has one door.

export type DraftActionResult = ActionResult & { draft?: JobDraftView };

export async function previewJobAction(input: CreateJobInput): Promise<ActionResult & { preview?: JobPreview }> {
  try {
    return { ok: true, preview: await previewJob(await requireActor(), input) };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveDraftAction(draftId: number | undefined, payload: unknown): Promise<DraftActionResult> {
  try {
    const draft = await saveDraft(await requireActor(), { draftId, payload });
    return { ok: true, draft };
  } catch (e) {
    return toActionError(e);
  }
}

export async function copyJobToDraftAction(jobId: number): Promise<DraftActionResult> {
  try {
    return { ok: true, draft: await copyJobToDraft(await requireActor(), { jobId }) };
  } catch (e) {
    return toActionError(e);
  }
}

export async function releaseDraftAction(draftId: number): Promise<DraftActionResult & { job?: CreateJobResult }> {
  try {
    const { job } = await releaseDraft(await requireActor(), { draftId });
    // No revalidatePath here: in a Server Action it re-renders the page the wizard is on, and that page
    // answers a released draft with "already turned into a job", replacing the result step. /jobs is dynamic.
    return { ok: true, job };
  } catch (e) {
    return toActionError(e);
  }
}

export async function discardDraftAction(draftId: number): Promise<DraftActionResult> {
  try {
    return { ok: true, draft: await discardDraft(await requireActor(), { draftId }) };
  } catch (e) {
    return toActionError(e);
  }
}
