"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { mapBomLines, releaseBomRevision, startBomRevision, type BomReleaseResult } from "@/lib/services/bom-release.service";
import { toActionError, type ActionResult } from "./_action";

/**
 * J5b: the BOM release screen's three writes. Thin callers: the rules (roles, refusals, warnings,
 * idempotency) live in bom-release.service. The preview is read in the page itself.
 */
function refresh(jobId: number) {
  revalidatePath(`/jobs/${jobId}/release`);
  revalidatePath(`/jobs/${jobId}`);
}

export type StartRevisionActionResult = ActionResult & { bomRevisionId?: number; revisionNo?: number; created?: boolean; moved?: number };
export async function startBomRevisionAction(jobId: number, equipmentId: number): Promise<StartRevisionActionResult> {
  try {
    const r = await startBomRevision(await requireActor(), { equipmentId });
    refresh(jobId);
    return { ok: true, bomRevisionId: r.bomRevisionId, revisionNo: r.revisionNo, created: r.created, moved: r.moved };
  } catch (e) {
    return toActionError(e);
  }
}

export async function mapBomLinesAction(
  jobId: number,
  bomRevisionId: number,
  lines: { bomItemId: number; componentTypeId: number | null; routeVariant: string | null }[],
): Promise<ActionResult & { updated?: number }> {
  try {
    const r = await mapBomLines(await requireActor(), { bomRevisionId, lines });
    refresh(jobId);
    return { ok: true, updated: r.updated };
  } catch (e) {
    return toActionError(e);
  }
}

export type ReleaseActionResult = ActionResult & { release?: BomReleaseResult };
export async function releaseBomRevisionAction(
  jobId: number,
  equipmentId: number,
  bomRevisionId: number,
  acknowledgeWarnings: boolean,
): Promise<ReleaseActionResult> {
  try {
    const release = await releaseBomRevision(await requireActor(), { equipmentId, bomRevisionId, acknowledgeWarnings });
    refresh(jobId);
    return { ok: true, release };
  } catch (e) {
    return toActionError(e);
  }
}
