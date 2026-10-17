"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActor } from "@/lib/authz";
import {
  applyTrackerImport,
  dryRunTrackerImport,
  type ApplyReport,
  type BlockChoice,
  type TrackerReport,
} from "@/lib/services/job-import.service";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { checkWorkbookUpload } from "@/lib/shared/upload";
import { toActionError, type ActionResult } from "./_action";

/**
 * Lean Core L2.10 part A: load a DESPL tracker sheet into a job.
 * Stateless like the master-data import: the browser keeps the File and sends
 * it with every call; Load sends back the file hash and plan fingerprint from
 * the check, and the service refuses a different file or a changed plan.
 */
const choicesSchema = z
  .array(
    z
      .object({ blockNo: z.number().int().positive(), equipmentId: z.number().int().positive().optional(), newName: z.string().max(200).optional() })
      .strict(),
  )
  .max(200);

async function read(fd: FormData): Promise<{ jobId: number; bytes: Buffer; name: string; choices: BlockChoice[] | null }> {
  const file = fd.get("file");
  if (!(file instanceof File)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Choose a workbook first." });
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = checkWorkbookUpload({ name: file.name, size: bytes.length, head: bytes.subarray(0, 4) });
  if (problem) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: problem });
  const jobId = Number(fd.get("jobId"));
  if (!Number.isInteger(jobId) || jobId <= 0) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "No job." });
  const raw = String(fd.get("choices") ?? "");
  let choices: BlockChoice[] | null = null;
  if (raw) {
    try {
      choices = choicesSchema.parse(JSON.parse(raw));
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "The equipment choices could not be read. Reload the page." });
    }
  }
  return { jobId, bytes, name: file.name, choices };
}

export type PreviewTrackerResult = ActionResult & { report?: TrackerReport };

export async function previewTrackerImportAction(fd: FormData): Promise<PreviewTrackerResult> {
  try {
    const actor = await requireActor();
    const { jobId, bytes, choices } = await read(fd);
    return { ok: true, report: await dryRunTrackerImport(actor, jobId, bytes, choices) };
  } catch (e) {
    return toActionError(e);
  }
}

export type ApplyTrackerResult = ActionResult & { applied?: ApplyReport };

export async function applyTrackerImportAction(fd: FormData): Promise<ApplyTrackerResult> {
  try {
    const actor = await requireActor();
    const { jobId, bytes, name, choices } = await read(fd);
    const fileSha256 = String(fd.get("fileSha256") ?? "");
    const planFingerprint = String(fd.get("planFingerprint") ?? "");
    if (!/^[0-9a-f]{64}$/.test(fileSha256) || !/^[0-9a-f]{64}$/.test(planFingerprint)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Check the file first; there is nothing to load yet." });
    }
    const applied = await applyTrackerImport(actor, jobId, bytes, choices, { expected: { fileSha256, planFingerprint }, fileName: name });
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath(`/jobs/${jobId}/import`);
    return { ok: true, applied };
  } catch (e) {
    return toActionError(e);
  }
}
