"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { createAssemblyDrawing, createDrawingRevision, releaseDrawingAtRisk } from "@/lib/services/drawing.service";
import { linkDrawingToComponents } from "@/lib/services/component.service";
import { toActionError, type ActionResult } from "./_action";

export async function createDrawingRevisionAction(
  jobId: number,
  assemblyDrawingId: number,
  revisionNo: number,
  status: "DRAFT" | "RELEASED",
): Promise<ActionResult> {
  try {
    await createDrawingRevision(await requireActor(), { jobId, assemblyDrawingId, revisionNo, status });
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath(`/jobs/${jobId}/drawings`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function releaseDrawingAtRiskAction(
  jobId: number,
  drawingRevisionId: number,
  reason: string,
  clientConsentRef?: string,
): Promise<ActionResult> {
  try {
    await releaseDrawingAtRisk(await requireActor(), { jobId, drawingRevisionId, reason, clientConsentRef });
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath(`/jobs/${jobId}/drawings`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function createAssemblyDrawingAction(
  jobId: number,
  drawingTypeId: number,
  drawingNo: string,
  remarks?: string,
): Promise<ActionResult> {
  try {
    await createAssemblyDrawing(await requireActor(), { jobId, drawingTypeId, drawingNo, remarks: remarks || undefined });
    revalidatePath(`/jobs/${jobId}/drawings`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function linkDrawingToComponentsAction(
  jobId: number,
  assemblyDrawingId: number,
  componentIds: number[],
): Promise<ActionResult> {
  try {
    await linkDrawingToComponents(await requireActor(), { jobId, assemblyDrawingId, componentIds });
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath(`/jobs/${jobId}/drawings`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
