"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { receiveStock, issueStock, returnStock, scrapStock } from "@/lib/services/stock.service";
import { toActionError, type ActionResult } from "./_action";

export async function receiveStockAction(
  jobId: number,
  bomItemId: number,
  location: string,
  qty: number,
  heatNumber?: string,
  sourceProcurementEventId?: number,
): Promise<ActionResult> {
  try {
    await receiveStock(await requireActor(), { bomItemId, location, qty, heatNumber, sourceProcurementEventId });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function issueStockAction(
  jobId: number,
  stockLotId: number,
  qty: number,
  componentId?: number,
  note?: string,
): Promise<ActionResult> {
  try {
    await issueStock(await requireActor(), { stockLotId, qty, componentId, note });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function returnStockAction(
  jobId: number,
  stockLotId: number,
  qty: number,
  componentId?: number,
  note?: string,
): Promise<ActionResult> {
  try {
    await returnStock(await requireActor(), { stockLotId, qty, componentId, note });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function scrapStockAction(
  jobId: number,
  stockLotId: number,
  qty: number,
  componentId?: number,
  note?: string,
): Promise<ActionResult> {
  try {
    await scrapStock(await requireActor(), { stockLotId, qty, componentId, note });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
