"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { createDrawingRevision } from "@/lib/services/drawing.service";
import { toActionError, type ActionResult } from "./_action";

export async function createDrawingRevisionAction(
  jobId: number,
  assemblyDrawingId: number,
  revisionNo: number,
  status: "DRAFT" | "RELEASED",
): Promise<ActionResult> {
  try {
    await createDrawingRevision(await requireActor(), { assemblyDrawingId, revisionNo, status });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
