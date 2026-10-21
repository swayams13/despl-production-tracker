"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import {
  dryRunAssemblySequence,
  importAssemblySequence,
  publishAssemblyTemplateVersion,
  type AssemblySequenceReport,
  type ImportResult,
} from "@/lib/services/assembly-template.service";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { checkWorkbookUpload } from "@/lib/shared/upload";
import { toActionError, type ActionResult } from "./_action";

/**
 * Lean Core J4c: assembly sequence of an equipment type, from the master workbook.
 * Nothing is stored between calls: the browser keeps the File and sends it with each
 * call; import refuses a plan other than the one the user checked.
 */
async function readWorkbook(fd: FormData): Promise<{ bytes: Buffer; name: string }> {
  const file = fd.get("file");
  if (!(file instanceof File)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Choose a workbook first." });
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = checkWorkbookUpload({ name: file.name, size: bytes.length, head: bytes.subarray(0, 4) });
  if (problem) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: problem });
  return { bytes, name: file.name };
}

function typeId(fd: FormData): number {
  const n = Number(fd.get("equipmentTypeId"));
  if (!Number.isInteger(n) || n <= 0) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Choose an equipment type." });
  return n;
}

export type CheckAssemblySequenceResult = ActionResult & { report?: AssemblySequenceReport };

export async function checkAssemblySequenceAction(fd: FormData): Promise<CheckAssemblySequenceResult> {
  try {
    const actor = await requireActor();
    const { bytes } = await readWorkbook(fd);
    const label = String(fd.get("label") ?? "").trim();
    const report = await dryRunAssemblySequence(actor, bytes, { equipmentTypeId: typeId(fd), label: label || null });
    return { ok: true, report };
  } catch (e) {
    return toActionError(e);
  }
}

export type ImportAssemblySequenceResult = ActionResult & { imported?: ImportResult };

export async function importAssemblySequenceAction(fd: FormData): Promise<ImportAssemblySequenceResult> {
  try {
    const actor = await requireActor();
    const { bytes, name } = await readWorkbook(fd);
    const label = String(fd.get("label") ?? "").trim();
    const planFingerprint = String(fd.get("planFingerprint") ?? "");
    if (!label || !/^[0-9a-f]{64}$/.test(planFingerprint)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Check the file first; there is nothing to import yet." });
    }
    const imported = await importAssemblySequence(actor, bytes, { equipmentTypeId: typeId(fd), label, fileName: name, planFingerprint });
    revalidatePath("/admin/equipment-types");
    return { ok: true, imported };
  } catch (e) {
    return toActionError(e);
  }
}

export async function publishAssemblyTemplateVersionAction(input: { versionId: number }): Promise<ActionResult> {
  try {
    await publishAssemblyTemplateVersion(await requireActor(), { versionId: Number(input?.versionId) });
    revalidatePath("/admin/equipment-types");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
