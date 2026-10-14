"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActor } from "@/lib/authz";
import {
  approvePartFamily,
  editPartFamily,
  revisePartFamily,
  saveRouteDraft,
  setMaterialStatus,
  setPartFamilyReviewed,
  upsertMaterialGrade,
  type ApproveResult,
  type SaveRouteResult,
} from "@/lib/services/master-data.service";
import { isAppError } from "@/lib/shared/errors";
import { toActionError, type ActionResult } from "./_action";
import type {
  EditPartFamilyInput,
  PartFamilyIdInput,
  RevisePartFamilyInput,
  SaveRouteDraftInput,
  SetMaterialStatusInput,
  UpsertMaterialGradeInput,
} from "@/lib/shared/schemas";

const LIST = "/admin/master-data";
const detail = (id: number) => `/admin/master-data/${id}`;

export type ApprovePartFamilyResult = ActionResult & Partial<Pick<ApproveResult, "selfApproved" | "published">>;

export async function approvePartFamilyAction(input: PartFamilyIdInput): Promise<ApprovePartFamilyResult> {
  try {
    const r = await approvePartFamily(await requireActor(), input);
    revalidatePath(LIST);
    revalidatePath(detail(input.partFamilyId));
    return { ok: true, selfApproved: r.selfApproved, published: r.published };
  } catch (e) {
    return toActionError(e);
  }
}

export async function revisePartFamilyAction(input: RevisePartFamilyInput): Promise<ActionResult> {
  try {
    await revisePartFamily(await requireActor(), input);
    revalidatePath(LIST);
    revalidatePath(detail(input.partFamilyId));
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function editPartFamilyAction(input: EditPartFamilyInput): Promise<ActionResult> {
  try {
    await editPartFamily(await requireActor(), input);
    revalidatePath(LIST);
    revalidatePath(detail(input.partFamilyId));
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export type SaveRouteDraftResult = ActionResult & Partial<Pick<SaveRouteResult, "variant" | "version" | "status" | "action" | "readiness">>;

export async function saveRouteDraftAction(input: SaveRouteDraftInput): Promise<SaveRouteDraftResult> {
  try {
    const r = await saveRouteDraft(await requireActor(), input);
    revalidatePath(LIST);
    revalidatePath(detail(input.partFamilyId));
    return { ok: true, variant: r.variant, version: r.version, status: r.status, action: r.action, readiness: r.readiness };
  } catch (e) {
    return toActionError(e);
  }
}

export type ReviewPartFamiliesResult =
  | { ok: true; reviewed: number[]; refused: Array<{ id: number; code: string; message: string }> }
  | { ok: false; code: string; message: string };

/**
 * Mark several parts reviewed. Partial success is the point: a row the actor
 * made the last change to is refused with its reason, the others still go through.
 */
export async function reviewPartFamiliesAction(ids: number[]): Promise<ReviewPartFamiliesResult> {
  const parsed = z.array(z.number().int().positive()).min(1).max(100).safeParse(ids);
  if (!parsed.success) return { ok: false, code: "VALIDATION_FAILED", message: "Pick between 1 and 100 parts." };
  let actor;
  try {
    actor = await requireActor();
  } catch (e) {
    const r = toActionError(e);
    return r.ok ? { ok: false, code: "UNAUTHENTICATED", message: "Sign in again." } : { ok: false, code: r.code, message: r.message };
  }
  const reviewed: number[] = [];
  const refused: Array<{ id: number; code: string; message: string }> = [];
  for (const id of parsed.data) {
    try {
      await setPartFamilyReviewed(actor, { partFamilyId: id });
      reviewed.push(id);
    } catch (e) {
      if (isAppError(e)) {
        const r = toActionError(e);
        refused.push({ id, code: e.code, message: r.ok ? e.message : r.message });
      } else {
        refused.push({ id, code: "UNKNOWN", message: "This part could not be marked reviewed." });
      }
    }
  }
  revalidatePath(LIST);
  return { ok: true, reviewed, refused };
}

// ── Material grades ──────────────────────────────────────────────────────

const MATERIALS = "/admin/master-data/materials";

export async function saveMaterialGradeAction(input: UpsertMaterialGradeInput): Promise<ActionResult & { id?: number }> {
  try {
    const r = await upsertMaterialGrade(await requireActor(), input);
    revalidatePath(MATERIALS);
    return { ok: true, id: r.id };
  } catch (e) {
    return toActionError(e);
  }
}

export async function setMaterialStatusAction(input: SetMaterialStatusInput): Promise<ActionResult> {
  try {
    await setMaterialStatus(await requireActor(), input);
    revalidatePath(MATERIALS);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/** Move several grades to REVIEWED or APPROVED; a grade that cannot move is skipped with its reason. */
export async function setMaterialStatusBulkAction(
  ids: number[],
  to: "REVIEWED" | "APPROVED",
): Promise<ReviewPartFamiliesResult> {
  const parsed = z.array(z.number().int().positive()).min(1).max(200).safeParse(ids);
  if (!parsed.success) return { ok: false, code: "VALIDATION_FAILED", message: "Pick between 1 and 200 grades." };
  let actor;
  try {
    actor = await requireActor();
  } catch (e) {
    const r = toActionError(e);
    return r.ok ? { ok: false, code: "UNAUTHENTICATED", message: "Sign in again." } : { ok: false, code: r.code, message: r.message };
  }
  const reviewed: number[] = [];
  const refused: Array<{ id: number; code: string; message: string }> = [];
  for (const id of parsed.data) {
    try {
      await setMaterialStatus(actor, { materialGradeId: id, to });
      reviewed.push(id);
    } catch (e) {
      if (isAppError(e)) {
        const r = toActionError(e);
        const reason = !r.ok ? ((r.detail as { reason?: string; blockers?: Array<{ message?: string }> } | undefined)?.reason ?? r.detail?.blockers) : undefined;
        const text = typeof reason === "string" ? reason : Array.isArray(reason) ? reason.map((b) => b.message).filter(Boolean).join(" ") : "";
        refused.push({ id, code: e.code, message: text || (r.ok ? e.message : r.message) });
      } else {
        refused.push({ id, code: "UNKNOWN", message: "This grade could not be moved." });
      }
    }
  }
  revalidatePath(MATERIALS);
  return { ok: true, reviewed, refused };
}
