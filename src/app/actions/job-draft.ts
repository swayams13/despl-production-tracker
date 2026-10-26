"use server";
import { requireActor } from "@/lib/authz";
import { saveDraft, copyJobToDraft, releaseDraft, discardDraft, type JobDraftView } from "@/lib/services/job-draft.service";
import { previewJob, type JobPreview } from "@/lib/services/job-preview.service";
import { previewBomUpload, type BomUploadPreview } from "@/lib/services/bom-upload.service";
import type { CreateJobResult } from "@/lib/services/job-intake.service";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
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

/** Wizard "Upload a BOM Excel file": read the file and say what it holds. Writes nothing; the lines are kept in the draft. */
export async function previewBomUploadAction(fd: FormData): Promise<ActionResult & { preview?: BomUploadPreview }> {
  try {
    const actor = await requireActor();
    const file = fd.get("file");
    if (!(file instanceof File)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Choose a file first." }, "Choose a file first.");
    return { ok: true, preview: await previewBomUpload(actor, { fileName: file.name, bytes: Buffer.from(await file.arrayBuffer()) }) };
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
