"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { dryRunMasterImport, type DryRunReport } from "@/lib/services/master-import.service";
import { applyMasterImport, type ApplyResult } from "@/lib/services/master-import.apply";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { checkWorkbookUpload } from "@/lib/shared/upload";
import { toActionError, type ActionResult } from "./_action";

/**
 * Upload of the Standard Parts Master workbook (Lean Core M3-C).
 *
 * Nothing is stored: the browser keeps the File and sends it with each call.
 * Check (read-only) returns the report plus the file hash and plan fingerprint;
 * Load sends those back and apply refuses a different file or a changed plan.
 */
async function readWorkbook(fd: FormData): Promise<{ bytes: Buffer; name: string }> {
  const file = fd.get("file");
  if (!(file instanceof File)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Choose a workbook first." });
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = checkWorkbookUpload({ name: file.name, size: bytes.length, head: bytes.subarray(0, 4) });
  if (problem) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: problem });
  return { bytes, name: file.name };
}

export type PreviewMasterImportResult = ActionResult & { report?: DryRunReport };

export async function previewMasterImportAction(fd: FormData): Promise<PreviewMasterImportResult> {
  try {
    const actor = await requireActor();
    const { bytes } = await readWorkbook(fd);
    const report = await dryRunMasterImport(actor, bytes, { allowDraft: fd.get("allowDraft") === "1" });
    return { ok: true, report };
  } catch (e) {
    return toActionError(e);
  }
}

export type ApplyMasterImportResult = ActionResult & {
  /** The plan the user confirmed, and what was written; never the issue list a second time. */
  plan?: DryRunReport["plan"];
  written?: ApplyResult["written"];
  fileSha256?: string;
};

export async function applyMasterImportAction(fd: FormData): Promise<ApplyMasterImportResult> {
  try {
    const actor = await requireActor();
    const { bytes, name } = await readWorkbook(fd);
    const fileSha256 = String(fd.get("fileSha256") ?? "");
    const planFingerprint = String(fd.get("planFingerprint") ?? "");
    if (!/^[0-9a-f]{64}$/.test(fileSha256) || !/^[0-9a-f]{64}$/.test(planFingerprint)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Check the file first; there is nothing to load yet." });
    }
    const r = await applyMasterImport(actor, bytes, {
      allowDraft: fd.get("allowDraft") === "1",
      expected: { fileSha256, planFingerprint },
      fileName: name,
    });
    revalidatePath("/admin/master-data");
    revalidatePath("/admin/master-data/materials");
    return { ok: true, plan: r.report.plan, written: r.written, fileSha256: r.report.fileSha256 };
  } catch (e) {
    return toActionError(e);
  }
}
