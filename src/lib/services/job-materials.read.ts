import { inRoute, routeKey } from "./line-route";
import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { derivePipeline, isShortThisWeek, materialStatus, type MaterialFacts, type MaterialStatus, type PipelineChip } from "@/lib/shared/job-materials";
import { resolveProcessSeq, stepKey } from "@/lib/shared/stage-mapping";
import { explodeBomItem, type ExplodableBomItem } from "./bom-explosion";
import { getCurrentScheduleRun } from "./_shared";

/**
 * Lean Core L2.8 (frame 07B): the Materials tab's pipeline. One row per BOM
 * line across the job's equipment, each with the five chips derived by the pure
 * `job-materials.ts` from rows other screens already write (procurement events,
 * stock lots and transactions, heat records). Read-only: the Stores actions
 * stay on "Parts and stock" (`loadBomTree`).
 *
 * **Needed by** has no column anywhere, so it is derived: the earliest planned
 * start, on the job's current schedule, of the first process on the route of the
 * components built from the line. A component is built from the line when it
 * names it (`bomItemId`), or, for a bomless sub-assembly register such as
 * DESPL-320's, when it has the same component type on the same equipment.
 * ponytail: the type match is a heuristic; a real BOM-to-component link (J5)
 * replaces it. No route or no plan, null: shown as a dash, never guessed.
 */
export interface MaterialLine {
  id: number;
  itemNo: number;
  partName: string;
  description: string | null;
  material: string | null;
  equipmentName: string;
  /** Source quantity as written ("40 NOS."). */
  qtyLabel: string;
  requiredQty: number | null;
  chips: PipelineChip[];
  status: MaterialStatus;
  statusLabel: string;
  short: boolean;
  neededBy: string | null;
  /** The process the needed-by date comes from. */
  neededFor: string | null;
  receivedQty: number | null;
  issuedQty: number;
  events: Array<{ type: string; qty: number | null; refNo: string | null; at: string }>;
  heats: string[];
}

export interface JobMaterials {
  lines: MaterialLine[];
  shortCount: number;
  multipleEquipment: boolean;
}

export async function loadJobMaterials(actor: Actor, jobId: number, now: Date = new Date()): Promise<JobMaterials | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true, familyId: true, templateVersionId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const [equipments, items, components, familySeqRows, stepSeqRows, run, jobProcesses] = await Promise.all([
      tx.equipment.findMany({ where: { jobId }, select: { id: true, name: true, templateVersionId: true, _count: { select: { units: true } } }, orderBy: { id: "asc" } }),
      tx.bomItem.findMany({
        where: { jobId },
        orderBy: [{ equipmentId: "asc" }, { itemNo: "asc" }],
        select: {
          id: true,
          equipmentId: true,
          itemNo: true,
          partName: true,
          description: true,
          material: true,
          sourceQty: true,
          qtyPer: true,
          parentBomItemId: true,
          componentTypeId: true,
          materialIdentifications: { select: { heatNumber: true } },
          procurementEvents: { select: { type: true, qty: true, refNo: true, at: true } },
          stockLots: { select: { qty: true, txns: { select: { type: true, qty: true } } } },
        },
      }),
      tx.component.findMany({
        where: { equipment: { jobId } },
        select: {
          equipmentId: true,
          bomItemId: true,
          componentTypeId: true,
          routeVersion: { select: { id: true, steps: { orderBy: { seq: "asc" }, take: 1, select: { seq: true, operation: { select: { id: true } } } } } },
        },
      }),
      tx.operationRefFamilySeq.findMany({ where: { familyId: job.familyId }, select: { operationRefId: true, leadTimeProcessSeq: true } }),
      tx.routeStepFamilySeq.findMany({
        where: { familyId: job.familyId },
        select: { leadTimeProcessSeq: true, routeStep: { select: { routeVersionId: true, seq: true } } },
      }),
      getCurrentScheduleRun(tx, jobId),
      tx.jobProcess.findMany({ where: { jobId }, select: { id: true, code: true, name: true, equipmentId: true, grain: true } }),
    ]);

    const seqByOperation = new Map(familySeqRows.map((r) => [r.operationRefId, r.leadTimeProcessSeq]));
    const seqByStep = new Map(stepSeqRows.map((r) => [stepKey(r.routeStep.routeVersionId, r.routeStep.seq), r.leadTimeProcessSeq]));

    // earliest planned start per process code on the current schedule
    const processById = new Map(jobProcesses.map((p) => [p.id, p]));
    // J3b: per route (codes repeat across a job's routes), so a component reads the start of its own line's process.
    const startsOf = new Map<number, { at: Date; name: string; code: string; equipmentId: number | null; grain: string }>();
    for (const pl of run?.processPlans ?? []) {
      const jp = processById.get(pl.jobProcessId);
      if (!jp || !pl.plannedStart) continue;
      const cur = startsOf.get(jp.id);
      if (!cur || pl.plannedStart < cur.at) startsOf.set(jp.id, { at: pl.plannedStart, name: jp.name, code: jp.code, equipmentId: jp.equipmentId, grain: jp.grain });
    }
    const startForCode = (key: number | null, code: string) =>
      [...startsOf.values()].filter((s) => s.code === code && inRoute(s, key)).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    const keyOfEquipment = new Map(equipments.map((e) => [e.id, routeKey(job.templateVersionId, e)]));

    const firstUse = components.flatMap((c) => {
      const step = c.routeVersion?.steps[0];
      if (!step) return [];
      const seq = resolveProcessSeq({ operationId: step.operation.id, seq: step.seq, routeVersionId: c.routeVersion!.id }, seqByStep, seqByOperation);
      const hit = seq == null ? undefined : startForCode(keyOfEquipment.get(c.equipmentId) ?? null, String(seq));
      return hit ? [{ equipmentId: c.equipmentId, bomItemId: c.bomItemId, componentTypeId: c.componentTypeId, at: hit.at, name: hit.name }] : [];
    });

    const equipmentById = new Map(equipments.map((e) => [e.id, e]));
    const itemsByEquipment = new Map<number, Map<number, ExplodableBomItem>>();
    for (const it of items) {
      const m = itemsByEquipment.get(it.equipmentId) ?? new Map<number, ExplodableBomItem>();
      m.set(it.id, { id: it.id, qtyPer: it.qtyPer, parentBomItemId: it.parentBomItemId });
      itemsByEquipment.set(it.equipmentId, m);
    }

    const lines: MaterialLine[] = items.map((it) => {
      const eq = equipmentById.get(it.equipmentId);
      let requiredQty: number | null = null;
      try {
        requiredQty = explodeBomItem({ id: it.id, qtyPer: it.qtyPer, parentBomItemId: it.parentBomItemId }, eq?._count.units ?? 0, itemsByEquipment.get(it.equipmentId)!).toNumber();
      } catch {
        requiredQty = null; // free-text quantity somewhere up the chain
      }

      const used = firstUse
        .filter((u) => u.bomItemId === it.id || (u.bomItemId == null && u.equipmentId === it.equipmentId && it.componentTypeId != null && u.componentTypeId === it.componentTypeId))
        .sort((a, b) => a.at.getTime() - b.at.getTime())[0];

      const events = [...it.procurementEvents].sort((a, b) => a.at.getTime() - b.at.getTime());
      const lotQty = it.stockLots.reduce((s, l) => s + l.qty.toNumber(), 0);
      const knownReceipts = events.filter((e) => e.type === "RECEIPT" && e.qty != null);
      const receivedQty = it.stockLots.length ? lotQty : knownReceipts.length ? knownReceipts.reduce((s, e) => s + e.qty!.toNumber(), 0) : null;
      const txn = (t: string) => it.stockLots.reduce((s, l) => s + l.txns.filter((x) => x.type === t).reduce((a, x) => a + x.qty.toNumber(), 0), 0);
      const types = new Set(events.map((e) => e.type));

      const facts: MaterialFacts = {
        requiredQty,
        indent: types.has("INDENT_APPROVED") ? "approved" : types.has("INDENT_RAISED") ? "raised" : null,
        poPlaced: types.has("PO_PLACED"),
        anyReceipt: types.has("RECEIPT") || it.stockLots.length > 0,
        receivedQty,
        heats: [...new Set(it.materialIdentifications.map((m) => m.heatNumber))],
        issuedQty: txn("ISSUE") - txn("RETURN"),
        neededBy: used ? used.at.toISOString() : null,
      };
      const st = materialStatus(facts, now);
      return {
        id: it.id,
        itemNo: it.itemNo,
        partName: it.partName,
        description: it.description,
        material: it.material,
        equipmentName: eq?.name ?? "",
        qtyLabel: it.sourceQty,
        requiredQty,
        chips: derivePipeline(facts, now),
        status: st.status,
        statusLabel: st.label,
        short: isShortThisWeek(facts, now),
        neededBy: facts.neededBy,
        neededFor: used?.name ?? null,
        receivedQty,
        issuedQty: facts.issuedQty,
        events: events.map((e) => ({ type: e.type, qty: e.qty?.toNumber() ?? null, refNo: e.refNo, at: e.at.toISOString() })),
        heats: facts.heats,
      };
    });

    return { lines, shortCount: lines.filter((l) => l.short).length, multipleEquipment: equipments.length > 1 };
  });
}
