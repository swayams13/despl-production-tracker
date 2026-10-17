"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActor } from "@/lib/authz";
import { issueAndPickHeat, loadHeatChoices, pickHeatNumber, type HeatChoices } from "@/lib/services/heat.service";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { FEATURES } from "@/lib/shared/flags";
import { toActionError, type ActionResult } from "./_action";

/**
 * Lean Core L2.13: pick the heat number of a pressure part where it is cut.
 * Thin callers of heat.service; off with the lean floor (LEAN_FLOOR unset), like recordWork's own actions.
 */
const id = z.number().int().positive();
const pickSchema = z.object({ componentId: id, stockLotId: id }).strict();
const issueSchema = z.object({ componentId: id, stockLotId: id, qty: z.number().positive() }).strict();

function gate() {
  if (!FEATURES.leanFloor) throw new AppError(ERROR_CODES.FEATURE_FROZEN, { feature: "leanFloor" });
}
const PATHS = ["/today", "/workspace", "/dashboard", "/my-day"];

export type HeatChoicesResult = ActionResult & { choices?: HeatChoices };

export async function loadHeatChoicesAction(componentId: number): Promise<HeatChoicesResult> {
  try {
    gate();
    return { ok: true, choices: await loadHeatChoices(await requireActor(), id.parse(componentId)) };
  } catch (e) {
    return toActionError(e);
  }
}

export async function pickHeatNumberAction(input: z.input<typeof pickSchema>): Promise<ActionResult> {
  try {
    gate();
    await pickHeatNumber(await requireActor(), pickSchema.parse(input));
    for (const p of PATHS) revalidatePath(p);
    revalidatePath("/u/[publicId]", "page");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function issueAndPickHeatAction(input: z.input<typeof issueSchema>): Promise<ActionResult> {
  try {
    gate();
    await issueAndPickHeat(await requireActor(), issueSchema.parse(input));
    for (const p of PATHS) revalidatePath(p);
    revalidatePath("/jobs/[id]/switch-over", "page");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
