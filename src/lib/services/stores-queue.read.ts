import { withTenant } from "@/lib/db";
import { assertNotClientUser, requireRole, type Actor } from "@/lib/authz";
import { derivePipeline, type MaterialFacts, type PipelineChip } from "@/lib/shared/job-materials";
import { MATERIALS_QUEUE_ROLES } from "@/lib/shared/stores-access";
import { storesNeeds, NEED_ORDER, type StoresNeed } from "@/lib/shared/stores-queue";
import { explodeBomItem, type ExplodableBomItem } from "./bom-explosion";

/**
 * Lean Core L2.14: Stores' cross-job queue (`/materials`). Every BOM line of an
 * active job that still needs something from Stores: to receive, to identify (no
 * heat number or MTC recorded against the line), to issue, or holding a lot received
 * with no heat number. Read only; the actions are on the job's Parts and stock.
 */
export const STORES_QUEUE_CAP = 500;

export interface StoresLine {
  id: number;
  jobId: number;
  jobNumber: string;
  projectName: string | null;
  equipmentName: string;
  itemNo: number;
  partName: string;
  material: string | null;
  qtyLabel: string;
  requiredQty: number | null;
  receivedQty: number | null;
  /** A receipt or stock lot exists, even when no quantity was recorded. */
  anyReceipt: boolean;
  issuedQty: number;
  heats: string[];
  lotsWithoutHeat: number;
  chips: PipelineChip[];
  needs: StoresNeed[];
}

export interface StoresQueue {
  lines: StoresLine[];
  counts: Record<StoresNeed, number>;
  /** More lines needed attention than the cap shows. */
  truncated: boolean;
}

export async function loadStoresQueue(actor: Actor, now: Date = new Date()): Promise<StoresQueue> {
  assertNotClientUser(actor);
  requireRole(actor, ...MATERIALS_QUEUE_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const jobs = await tx.job.findMany({
      where: { tenantId: actor.tenantId, status: "ACTIVE" },
      select: { id: true, jobNumber: true, projectName: true },
      orderBy: { jobNumber: "asc" },
    });
    const jobIds = jobs.map((j) => j.id);
    const counts: Record<StoresNeed, number> = { receive: 0, identify: 0, issue: 0, heat: 0 };
    if (!jobIds.length) return { lines: [], counts, truncated: false };

    const [equipments, items] = await Promise.all([
      tx.equipment.findMany({ where: { jobId: { in: jobIds } }, select: { id: true, name: true, _count: { select: { units: true } } } }),
      tx.bomItem.findMany({
        where: { jobId: { in: jobIds } },
        orderBy: [{ jobId: "asc" }, { equipmentId: "asc" }, { itemNo: "asc" }],
        select: {
          id: true, jobId: true, equipmentId: true, itemNo: true, partName: true, material: true, sourceQty: true, qtyPer: true, parentBomItemId: true,
          materialIdentifications: { select: { heatNumber: true } },
          procurementEvents: { select: { type: true, qty: true } },
          stockLots: { select: { qty: true, heatNumber: true, txns: { select: { type: true, qty: true } } } },
        },
      }),
    ]);

    const equipmentById = new Map(equipments.map((e) => [e.id, e]));
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const byEquipment = new Map<number, Map<number, ExplodableBomItem>>();
    for (const it of items) {
      const m = byEquipment.get(it.equipmentId) ?? new Map<number, ExplodableBomItem>();
      m.set(it.id, { id: it.id, qtyPer: it.qtyPer, parentBomItemId: it.parentBomItemId });
      byEquipment.set(it.equipmentId, m);
    }

    const all: StoresLine[] = [];
    for (const it of items) {
      const eq = equipmentById.get(it.equipmentId);
      let requiredQty: number | null = null;
      try {
        requiredQty = explodeBomItem({ id: it.id, qtyPer: it.qtyPer, parentBomItemId: it.parentBomItemId }, eq?._count.units ?? 0, byEquipment.get(it.equipmentId)!).toNumber();
      } catch {
        requiredQty = null; // free-text quantity somewhere up the chain
      }
      const types = new Set(it.procurementEvents.map((e) => e.type));
      const lotQty = it.stockLots.reduce((s, l) => s + l.qty.toNumber(), 0);
      const known = it.procurementEvents.filter((e) => e.type === "RECEIPT" && e.qty != null);
      const txn = (t: string) => it.stockLots.reduce((s, l) => s + l.txns.filter((x) => x.type === t).reduce((a, x) => a + x.qty.toNumber(), 0), 0);
      const facts: MaterialFacts = {
        requiredQty,
        indent: types.has("INDENT_APPROVED") ? "approved" : types.has("INDENT_RAISED") ? "raised" : null,
        poPlaced: types.has("PO_PLACED"),
        anyReceipt: types.has("RECEIPT") || it.stockLots.length > 0,
        receivedQty: it.stockLots.length ? lotQty : known.length ? known.reduce((s, e) => s + e.qty!.toNumber(), 0) : null,
        heats: [...new Set(it.materialIdentifications.map((m) => m.heatNumber))],
        issuedQty: txn("ISSUE") - txn("RETURN"),
        neededBy: null,
      };
      const lotsWithoutHeat = it.stockLots.filter((l) => !l.heatNumber).length;
      const needs = storesNeeds(facts, lotsWithoutHeat);
      if (!needs.length) continue;
      const job = jobById.get(it.jobId)!;
      all.push({
        id: it.id, jobId: it.jobId, jobNumber: job.jobNumber, projectName: job.projectName, equipmentName: eq?.name ?? "",
        itemNo: it.itemNo, partName: it.partName, material: it.material, qtyLabel: it.sourceQty,
        requiredQty, receivedQty: facts.receivedQty, anyReceipt: facts.anyReceipt, issuedQty: facts.issuedQty, heats: facts.heats, lotsWithoutHeat,
        chips: derivePipeline(facts, now), needs,
      });
    }
    for (const l of all) for (const n of NEED_ORDER) if (l.needs.includes(n)) counts[n]++;
    return { lines: all.slice(0, STORES_QUEUE_CAP), counts, truncated: all.length > STORES_QUEUE_CAP };
  });
}
