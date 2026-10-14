"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import * as svc from "@/lib/services/work.service";
import { raiseRuleNcr } from "@/lib/services/ncr.service";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { FEATURES } from "@/lib/shared/flags";
import type { InspectInput, RaiseRuleNcrInput, RecordWorkInput } from "@/lib/shared/schemas";
import { toActionError, type ActionResult } from "./_action";

/**
 * Lean Core L1.2e: the floor's two Server Actions, thin callers of
 * work.service. Off (LEAN_FLOOR unset) they refuse FEATURE_FROZEN before
 * touching a service, and the legacy start/submit/verify actions are unchanged.
 * Input is passed through as given: the service's zod schemas are strict, so a
 * client-sent actual/at time is a validation refusal, never stored.
 */
type WithResult<T> = { ok: true; result: T } | Exclude<ActionResult, { ok: true }>;

async function run<T>(fn: () => Promise<T>): Promise<WithResult<T>> {
  try {
    if (!FEATURES.leanFloor) throw new AppError(ERROR_CODES.FEATURE_FROZEN, { feature: "leanFloor" });
    const result = await fn();
    for (const path of ["/workspace", "/dashboard", "/my-day", "/board", "/qc"]) revalidatePath(path);
    return { ok: true, result };
  } catch (e) {
    return toActionError(e) as Exclude<ActionResult, { ok: true }>;
  }
}

export async function recordWorkAction(input: RecordWorkInput): Promise<WithResult<svc.RecordWorkResult>> {
  return run(async () => svc.recordWork(await requireActor(), input));
}

export async function inspectAction(input: InspectInput): Promise<WithResult<svc.InspectResult>> {
  return run(async () => svc.inspect(await requireActor(), input));
}

/** L1.2f: QC raises the NCR an H5/H6 refusal routes to. */
export async function raiseRuleNcrAction(input: RaiseRuleNcrInput): Promise<WithResult<{ ncrId: number }>> {
  return run(async () => ({ ncrId: (await raiseRuleNcr(await requireActor(), input)).id }));
}
