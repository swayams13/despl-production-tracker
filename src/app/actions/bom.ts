"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { recordMtc } from "@/lib/services/mtc.service";
import { recordProcurementEvent } from "@/lib/services/procurement.service";
import {
  createBomItem,
  updateBomItem,
  importBomItems,
  createBomRevision,
  type BomImportFailure,
} from "@/lib/services/bom.service";
import type { CreateBomItemInput, UpdateBomItemInput } from "@/lib/shared/schemas";
import { toActionError, type ActionResult } from "./_action";

export async function recordMtcAction(
  jobId: number,
  bomItemId: number,
  heatNumber: string,
  pmiResult: "NA" | "PENDING" | "ACCEPT" | "REJECT",
  mtcRef?: string,
  componentId?: number,
  qtyIssued?: number,
): Promise<ActionResult> {
  try {
    await recordMtc(await requireActor(), { bomItemId, heatNumber, mtcRef, pmiResult, componentId, qtyIssued });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function recordProcurementEventAction(
  jobId: number,
  bomItemId: number,
  type: "INDENT_RAISED" | "INDENT_APPROVED" | "PO_PLACED" | "RECEIPT",
  qty?: number,
  refNo?: string,
): Promise<ActionResult> {
  try {
    await recordProcurementEvent(await requireActor(), { bomItemId, type, qty, refNo });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/** B4, Phase 4 — manual BOM authoring: add a row by hand. */
export async function createBomItemAction(jobId: number, input: CreateBomItemInput): Promise<ActionResult> {
  try {
    await createBomItem(await requireActor(), input);
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/** B4, Phase 4 — manual BOM authoring: edit an existing row. */
export async function updateBomItemAction(
  jobId: number,
  bomItemId: number,
  input: UpdateBomItemInput,
): Promise<ActionResult> {
  try {
    await updateBomItem(await requireActor(), bomItemId, input);
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export type ImportBomItemsActionResult =
  | { ok: true; createdCount: number; failures: BomImportFailure[]; componentCount: number }
  | { ok: false; code: string; message: string };

/**
 * B4, Phase 4 — bulk CSV/XLSX import. `rows` is already parsed into plain
 * objects client-side (bom-panel.tsx uses `xlsx` in the browser, the same
 * library the QCP export route already uses server-side — no new
 * dependency). Never a silent partial success: `failures` always comes back
 * alongside the created count so the panel can report both.
 */
export async function importBomItemsAction(
  jobId: number,
  equipmentId: number,
  rows: unknown[],
  bomRevisionId?: number,
): Promise<ImportBomItemsActionResult> {
  try {
    const { created, failures, componentCount } = await importBomItems(await requireActor(), { equipmentId, bomRevisionId, rows });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, createdCount: created.length, failures, componentCount };
  } catch (e) {
    const result = toActionError(e); // never actually returns ok:true — non-AppError is rethrown inside
    if (result.ok) throw e;
    return result;
  }
}

/** B4, Phase 4 — issue a new `BomRevision` for an equipment (create-path B3 deferred). */
export async function createBomRevisionAction(
  jobId: number,
  equipmentId: number,
  revisionNo: number,
  status: "DRAFT" | "RELEASED",
): Promise<ActionResult> {
  try {
    await createBomRevision(await requireActor(), { equipmentId, revisionNo, status });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
