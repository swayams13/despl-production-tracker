"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import {
  addJointsFromTags,
  applyWeldMap,
  confirmWeldMap,
  dryRunWeldMap,
  type WeldMapApplied,
  type WeldMapReport,
} from "@/lib/services/weld-map.service";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { checkWorkbookUpload } from "@/lib/shared/upload";
import type { TagMode } from "@/lib/shared/weld-map";
import { toActionError, type ActionResult } from "./_action";

/**
 * Lean Core J4b: the weld map of one line. Stateless like the other imports:
 * the browser keeps the File and sends it with every call; Load sends back the
 * file hash and plan fingerprint from the check.
 */
async function read(fd: FormData): Promise<{ jobId: number; equipmentId: number; bytes: Buffer; name: string }> {
  const file = fd.get("file");
  if (!(file instanceof File)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Choose a workbook first." });
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = checkWorkbookUpload({ name: file.name, size: bytes.length, head: bytes.subarray(0, 4) });
  if (problem) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: problem });
  const jobId = Number(fd.get("jobId"));
  const equipmentId = Number(fd.get("equipmentId"));
  if (!Number.isInteger(jobId) || jobId <= 0 || !Number.isInteger(equipmentId) || equipmentId <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "No job or line." });
  }
  return { jobId, equipmentId, bytes, name: file.name };
}

export type PreviewWeldMapResult = ActionResult & { report?: WeldMapReport };

export async function previewWeldMapAction(fd: FormData): Promise<PreviewWeldMapResult> {
  try {
    const actor = await requireActor();
    const { jobId, equipmentId, bytes } = await read(fd);
    return { ok: true, report: await dryRunWeldMap(actor, { jobId, equipmentId }, bytes) };
  } catch (e) {
    return toActionError(e);
  }
}

export type ApplyWeldMapResult = ActionResult & { applied?: WeldMapApplied };

export async function applyWeldMapAction(fd: FormData): Promise<ApplyWeldMapResult> {
  try {
    const actor = await requireActor();
    const { jobId, equipmentId, bytes, name } = await read(fd);
    const fileSha256 = String(fd.get("fileSha256") ?? "");
    const planFingerprint = String(fd.get("planFingerprint") ?? "");
    if (!/^[0-9a-f]{64}$/.test(fileSha256) || !/^[0-9a-f]{64}$/.test(planFingerprint)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Check the file first; there is nothing to load yet." });
    }
    const applied = await applyWeldMap(actor, { jobId, equipmentId }, bytes, { expected: { fileSha256, planFingerprint }, fileName: name });
    revalidatePath(`/jobs/${jobId}/weld-map`);
    return { ok: true, applied };
  } catch (e) {
    return toActionError(e);
  }
}

export async function addJointsFromTagsAction(
  jobId: number,
  equipmentId: number,
  text: string,
  mode: TagMode,
  withFlanges: boolean,
): Promise<ActionResult & { added?: string[]; alreadyThere?: string[] }> {
  try {
    if (mode !== "NOZZLES" && mode !== "JOINTS") throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Choose what the list names." });
    const r = await addJointsFromTags(await requireActor(), { jobId, equipmentId, text, mode, withFlanges: !!withFlanges });
    revalidatePath(`/jobs/${jobId}/weld-map`);
    return { ok: true, ...r };
  } catch (e) {
    return toActionError(e);
  }
}

export async function confirmWeldMapAction(jobId: number, equipmentId: number, jointIds?: number[]): Promise<ActionResult & { confirmed?: string[] }> {
  try {
    if (jointIds && (!Array.isArray(jointIds) || jointIds.some((i) => !Number.isInteger(i) || i <= 0))) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Those joints could not be read." });
    }
    const r = await confirmWeldMap(await requireActor(), { jobId, equipmentId, jointIds });
    revalidatePath(`/jobs/${jobId}/weld-map`);
    return { ok: true, ...r };
  } catch (e) {
    return toActionError(e);
  }
}
