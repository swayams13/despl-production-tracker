"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { createDrawingRevision, releaseDrawingAtRisk } from "@/lib/services/drawing.service";
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
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
