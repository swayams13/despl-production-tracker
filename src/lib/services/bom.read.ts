import { Decimal } from "@prisma/client/runtime/library";
import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { PmiResult } from "@/generated/prisma/client";
import { projectComponentRoute, type ActualOp, type ProjectedOp, type RouteStepDef } from "./bom-route";
import { explodeBomItem, type ExplodableBomItem } from "./bom-explosion";

/**
 * Job detail — BOM & Components tab (§4.3, §9.6).
 *
 * **Deviation from the mockup, noted (same pattern as the §9.5 job-spine
 * rollup and C27):** the mockup groups items into "Shell / Heads / Nozzles /
 * Supports / Bought-out" — an illustrative taxonomy with no backing DB field.
 * The real seed's `ComponentTypeRef` assignment doesn't cleanly support it
 * (e.g. WNRF flanges are tagged `OTHER`, not `FLANGE`, in the live-CSV-sourced
 * data) — see `bom_items` for equipment 3. Grouping by the real
 * `ComponentTypeRef.name` (alphabetical, "Uncategorized" for items with none)
 * is honest to what's actually in the DB rather than inventing a bucket map
 * the data doesn't support (functional rule #2: real data only).
 *
 * **Equipment selector, plus a unit selector where components are fanned out
 * per serial:** `Component.unitId` is null for DE0463/DE0467 (BOM-item-linked
 * data still lives at equipment grain only there) but real for DESPL-320's
 * seeded sub-assembly register (`scripts/seed-despl320-components.ts`) — 11
 * rows per unit, 99 across the job. `subAssemblyComponents` is filtered to
 * one unit at a time once an equipment has any; `groups` (the BomItem-linked
 * path) stays equipment-scoped, unchanged.
 */
export interface BomQcpCheckpoint {
  qcpItemId: number;
  srNo: string;
  activity: string;
}

export interface BomComponentOp extends ProjectedOp {
  /** QCP checkpoints gated to this route step (via OperationRef.leadTimeProcessSeq → JobProcess → QcpItemProcess). */
  qcpCheckpoints: BomQcpCheckpoint[];
}

export interface BomComponentSummary {
  id: number;
  tag: string;
  /** Only populated for `BomTree.subAssemblyComponents` — real `ComponentTypeRef.name`, not a fabricated BOM category. */
  componentTypeName?: string;
  displayStatus: StageDisplayStatus;
  operations: BomComponentOp[];
}

export interface BomMtc {
  id: number;
  heatNumber: string;
  mtcRef: string | null;
  pmiResult: PmiResult;
}

/**
 * Derived from `ProcurementEvent` rows (B5, Phase 4) — replaces the old
 * mutable `Procurement` row. `status` is the type of the most recent event
 * (by `at`, ties broken by `id` descending); `receivedQty` is the sum of
 * `qty` across RECEIPT events that HAVE a known quantity — `null` when there
 * have been no RECEIPT events at all, or every RECEIPT so far has an unknown
 * quantity (kept distinct from `0`). `hasUnknownReceipt` is true whenever AT
 * LEAST ONE RECEIPT event has `qty: null`, even if others don't — task
 * review I1: a mixed known+unknown case (e.g. a backfilled
 * PARTIALLY_RECEIVED plus a later real receipt of 8) must not render as a
 * confident "8 received" with the unknown portion silently dropped from the
 * sum.
 */
export type ProcurementDisplayStatus = "NOT_STARTED" | "INDENT_RAISED" | "INDENT_APPROVED" | "PO_PLACED" | "RECEIPT";

export interface BomProcurementSummary {
  status: ProcurementDisplayStatus;
  receivedQty: number | null;
  hasUnknownReceipt: boolean;
  events: { id: number; type: Exclude<ProcurementDisplayStatus, "NOT_STARTED">; qty: number | null; refNo: string | null; at: string }[];
}

export interface BomItemRow {
  id: number;
  itemNo: number;
  partName: string;
  description: string | null;
  material: string | null;
  /** Raw source value (e.g. "40 NOS.") — kept for import fidelity and as the fallback display when `qtyPer` couldn't be parsed. */
  sourceQty: string;
  /** Parsed numeric quantity (B1); null when `sourceQty` didn't match the "N UOM" shape. */
  qtyPer: number | null;
  uom: string | null;
  mtc: BomMtc[];
  procurement: BomProcurementSummary;
  components: BomComponentSummary[];
  /** B6, Phase 4 — required quantity across the equipment's units (`explodeBomItem`).
   * `null` when this item's own chain has an unparsed `qtyPer` (nothing display-worthy to explode). */
  requiredQty: number | null;
  /** B6, Phase 4 — on-hand quantity from `StockLot`/`StockTxn`. `null` (never `0`) when this
   * item has zero stock activity at all — the SEAM principle: never tracked stays silent. */
  availableQty: number | null;
  /** B6, Phase 4 — `requiredQty - availableQty`; negative is surplus, shown as such, never clamped
   * here (the panel clamps for display). `null` whenever `availableQty` is `null`. */
  shortage: number | null;
}

/** No events yet → "NOT_STARTED", a status no `ProcurementEvent.type` value
 * carries — nothing has been logged for this item at all. Otherwise the
 * most recent event's type IS the status; there's no separate status field
 * to derive from a heuristic. */
function summarizeProcurement(
  events: { id: number; type: Exclude<ProcurementDisplayStatus, "NOT_STARTED">; qty: Decimal | null; refNo: string | null; at: Date }[],
): BomProcurementSummary {
  const sorted = [...events].sort((a, b) => b.at.getTime() - a.at.getTime() || b.id - a.id);
  const allReceipts = events.filter((e) => e.type === "RECEIPT");
  const knownReceipts = allReceipts.filter((e) => e.qty != null);
  const receivedQty = knownReceipts.length
    ? knownReceipts.reduce((sum, e) => sum + e.qty!.toNumber(), 0)
    : null;
  const hasUnknownReceipt = allReceipts.some((e) => e.qty == null);
  return {
    status: sorted[0]?.type ?? "NOT_STARTED",
    receivedQty,
    hasUnknownReceipt,
    events: sorted.map((e) => ({
      id: e.id,
      type: e.type,
      qty: e.qty != null ? e.qty.toNumber() : null,
      refNo: e.refNo,
      at: e.at.toISOString(),
    })),
  };
}

/** Quantity cell for the BOM tab: `qtyPer uom` when parsed, else the raw `sourceQty` — never `null`. */
export function formatBomQty(row: Pick<BomItemRow, "qtyPer" | "uom" | "sourceQty">): string {
  if (row.qtyPer == null) return row.sourceQty;
  return row.uom ? `${row.qtyPer} ${row.uom}` : String(row.qtyPer);
}

export interface BomGroup {
  name: string;
  items: BomItemRow[];
}

export interface EquipmentOption {
  id: number;
  name: string;
}

export interface UnitOption {
  id: number;
  serialNo: string;
}

export interface WelderOption {
  id: number;
  name: string;
}

export interface DelayCategoryOption {
  id: number;
  name: string;
}

export interface BomTree {
  equipmentId: number;
  equipmentName: string;
  equipments: EquipmentOption[];
  groups: BomGroup[];
  /**
   * `Component` rows for this equipment with no `BomItem` (bomItemId: null)
   * — e.g. DESPL-320's seeded sub-assembly register, which has no real
   * procurement BOM export to link to yet (see
   * `scripts/seed-despl320-components.ts`). Fabricating a fake `BomItem` to
   * hang these off would violate the "real data only" rule, so they get their
   * own section instead of being folded into `groups`.
   *
   * Filtered to one unit (`unitId`) when the equipment has any units with
   * their own bomless components — otherwise (DE0463/DE0467 today) this is
   * equipment-scoped, same as before per-serial fan-out existed.
   */
  subAssemblyComponents: BomComponentSummary[];
  /** Units for the current equipment — non-empty only when `subAssemblyComponents` is unit-fanned. */
  units: UnitOption[];
  /** The unit `subAssemblyComponents` is filtered to; null when there's nothing to filter by. */
  unitId: number | null;
  /** F3's Operator/Welder picker — active welders, tenant-wide (no per-operation department filter; keeps the picker simple). */
  welders: WelderOption[];
  /** F5's reject reason picker — same taxonomy `fileDelayReasonSchema` uses at process grain. */
  delayCategories: DelayCategoryOption[];
}

function opDisplayStatus(status: string): StageDisplayStatus {
  if (status === "COMPLETE") return "complete";
  if (status === "SUBMITTED") return "submitted";
  if (status === "IN_PROGRESS") return "progress";
  return "idle";
}

interface RawComponentForSummary {
  id: number;
  tag: string;
  componentType?: { name: string } | null;
  routeVersion: {
    steps: { seq: number; operation: { id: number; name: string; leadTimeProcessSeq: number | null } }[];
  } | null;
  operations: {
    id: number;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    remarks: string | null;
    qtyPlanned: number | null;
    qtyGood: number | null;
    qtyRejected: number | null;
    performedByWelder: { name: string } | null;
    performedByUser: { name: string } | null;
    rejections: { detail: string | null; category: { name: string } }[];
    operation: { id: number; name: string; leadTimeProcessSeq: number | null };
  }[];
}

/** Shared projection from a raw `Component` row (however it was reached — via
 * `BomItem.components` or directly by equipment) into the route-aware summary
 * shape both the BOM-item-linked path and the bomless sub-assembly path render. */
function buildComponentSummary(
  c: RawComponentForSummary,
  checkpointsByProcessCode: Map<string, BomQcpCheckpoint[]>,
): BomComponentSummary {
  const routeSteps: RouteStepDef[] = (c.routeVersion?.steps ?? []).map((s) => ({
    seq: s.seq,
    operationId: s.operation.id,
    operationName: s.operation.name,
    leadTimeProcessSeq: s.operation.leadTimeProcessSeq,
  }));
  const actualOps: ActualOp[] = c.operations.map((o) => ({
    id: o.id,
    operationId: o.operation.id,
    operationName: o.operation.name,
    status: o.status,
    startedAt: o.startedAt?.toISOString() ?? null,
    finishedAt: o.finishedAt?.toISOString() ?? null,
    leadTimeProcessSeq: o.operation.leadTimeProcessSeq,
    performedByWelderName: o.performedByWelder?.name ?? null,
    performedByUserName: o.performedByUser?.name ?? null,
    remarks: o.remarks,
    qtyPlanned: o.qtyPlanned,
    qtyGood: o.qtyGood,
    qtyRejected: o.qtyRejected,
    rejection: o.rejections[0] ? { categoryName: o.rejections[0].category.name, detail: o.rejections[0].detail } : null,
  }));
  const ops: BomComponentOp[] = projectComponentRoute(routeSteps, actualOps).map((p) => ({
    ...p,
    qcpCheckpoints: p.leadTimeProcessSeq != null ? (checkpointsByProcessCode.get(String(p.leadTimeProcessSeq)) ?? []) : [],
  }));
  const displayStatus: StageDisplayStatus =
    ops.length === 0
      ? "idle"
      : ops.every((o) => o.status === "COMPLETE")
        ? "complete"
        : opDisplayStatus(ops.find((o) => o.status !== "COMPLETE" && o.status !== "NOT_STARTED")?.status ?? ops[0].status);
  return { id: c.id, tag: c.tag, componentTypeName: c.componentType?.name, displayStatus, operations: ops };
}

export async function loadBomTree(
  actor: Actor,
  jobId: number,
  equipmentId?: number,
  unitId?: number,
): Promise<BomTree | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const equipments = await tx.equipment.findMany({
      where: { jobId },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });
    if (equipments.length === 0) {
      return {
        equipmentId: 0,
        equipmentName: "",
        equipments: [],
        groups: [],
        subAssemblyComponents: [],
        units: [],
        unitId: null,
        welders: [],
        delayCategories: [],
      };
    }

    const targetId = equipmentId != null && equipments.some((e) => e.id === equipmentId) ? equipmentId : equipments[0].id;
    const equipment = equipments.find((e) => e.id === targetId)!;

    const units = await tx.unit.findMany({
      where: { equipmentId: targetId },
      select: { id: true, serialNo: true },
      orderBy: { serialNo: "asc" },
    });
    const targetUnitId =
      units.length === 0 ? null : unitId != null && units.some((u) => u.id === unitId) ? unitId : units[0].id;

    const items = await tx.bomItem.findMany({
      where: { equipmentId: targetId },
      orderBy: { itemNo: "asc" },
      select: {
        id: true,
        itemNo: true,
        partName: true,
        description: true,
        material: true,
        sourceQty: true,
        qtyPer: true,
        uom: true,
        parentBomItemId: true,
        componentType: { select: { name: true } },
        materialIdentifications: { select: { id: true, heatNumber: true, mtcRef: true, pmiResult: true } },
        procurementEvents: {
          select: { id: true, type: true, qty: true, refNo: true, at: true },
        },
        stockLots: {
          select: { qty: true, txns: { select: { type: true, qty: true } } },
        },
        components: {
          select: {
            id: true,
            tag: true,
            componentType: { select: { name: true } },
            routeVersion: {
              select: {
                steps: {
                  orderBy: { seq: "asc" },
                  select: { seq: true, operation: { select: { id: true, name: true, leadTimeProcessSeq: true } } },
                },
              },
            },
            operations: {
              orderBy: { seq: "asc" },
              select: {
                id: true,
                status: true,
                startedAt: true,
                finishedAt: true,
                remarks: true,
                qtyPlanned: true,
                qtyGood: true,
                qtyRejected: true,
                performedByWelder: { select: { name: true } },
                performedByUser: { select: { name: true } },
                rejections: {
                  orderBy: { rejectedAt: "desc" },
                  take: 1,
                  select: { detail: true, category: { select: { name: true } } },
                },
                operation: { select: { id: true, name: true, leadTimeProcessSeq: true } },
              },
            },
          },
        },
      },
    });

    // Component rows for this equipment with no BomItem (bomItemId: null) —
    // e.g. DESPL-320's seeded sub-assembly register, unreachable via
    // `items[].components` above since that path only walks BomItem.components.
    // Scoped to one unit once the equipment has any (targetUnitId) — without
    // this, DESPL-320's 99 rows across 9 units would render as one flat list.
    const bomlessComponents = await tx.component.findMany({
      where: { equipmentId: targetId, bomItemId: null, ...(targetUnitId != null ? { unitId: targetUnitId } : {}) },
      orderBy: { tag: "asc" },
      select: {
        id: true,
        tag: true,
        componentType: { select: { name: true } },
        routeVersion: {
          select: {
            steps: {
              orderBy: { seq: "asc" },
              select: { seq: true, operation: { select: { id: true, name: true, leadTimeProcessSeq: true } } },
            },
          },
        },
        operations: {
          orderBy: { seq: "asc" },
          select: {
            id: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            remarks: true,
            qtyPlanned: true,
            qtyGood: true,
            qtyRejected: true,
            performedByWelder: { select: { name: true } },
            performedByUser: { select: { name: true } },
            rejections: {
              orderBy: { rejectedAt: "desc" },
              take: 1,
              select: { detail: true, category: { select: { name: true } } },
            },
            operation: { select: { id: true, name: true, leadTimeProcessSeq: true } },
          },
        },
      },
    });

    // Checkpoints gated to each of the job's 36 lead-time processes, keyed
    // by JobProcess.code (a stage seq number, as text) — the same identity
    // OperationRef.leadTimeProcessSeq points at.
    const checkpointLinks = await tx.qcpItemProcess.findMany({
      where: { jobProcess: { jobId } },
      select: {
        jobProcess: { select: { code: true } },
        qcpItem: { select: { id: true, srNo: true, activity: true } },
      },
    });
    const checkpointsByProcessCode = new Map<string, BomQcpCheckpoint[]>();
    for (const link of checkpointLinks) {
      const list = checkpointsByProcessCode.get(link.jobProcess.code) ?? [];
      list.push({ qcpItemId: link.qcpItem.id, srNo: link.qcpItem.srNo, activity: link.qcpItem.activity });
      checkpointsByProcessCode.set(link.jobProcess.code, list);
    }

    const subAssemblyComponents = bomlessComponents.map((c) => buildComponentSummary(c, checkpointsByProcessCode));

    // B6, Phase 4: required/available/shortage, computed inline (same
    // transaction, already-loaded data) rather than by calling the separate
    // exported `requiredQty`/`availableQty`/`shortage` — those each open
    // their own `withTenant` transaction, which would nest awkwardly if
    // called from inside this one. `itemsById` mirrors what `requiredQty`
    // builds itself; `unitCount` is this equipment's `Unit` row count, same
    // derivation.
    const itemsById = new Map<number, ExplodableBomItem>(
      items.map((it) => [it.id, { id: it.id, qtyPer: it.qtyPer, parentBomItemId: it.parentBomItemId }]),
    );
    const unitCount = units.length;

    const byGroup = new Map<string, BomItemRow[]>();
    for (const it of items) {
      const groupName = it.componentType?.name ?? "Uncategorized";

      let required: Decimal | null;
      try {
        required = explodeBomItem(itemsById.get(it.id)!, unitCount, itemsById);
      } catch {
        required = null; // unparsed qtyPer somewhere in the chain, or a cycle — nothing display-worthy to explode
      }

      // SEAM: zero StockLot rows for this item → null, never 0.
      let available: Decimal | null = null;
      if (it.stockLots.length > 0) {
        available = it.stockLots.reduce((sum, lot) => sum.plus(lot.qty), new Decimal(0));
        for (const lot of it.stockLots) {
          for (const t of lot.txns) {
            available = t.type === "RETURN" ? available.plus(t.qty) : available.minus(t.qty);
          }
        }
      }
      const shortageVal = available != null && required != null ? required.minus(available) : null;

      const row: BomItemRow = {
        id: it.id,
        itemNo: it.itemNo,
        partName: it.partName,
        description: it.description,
        material: it.material,
        sourceQty: it.sourceQty,
        qtyPer: it.qtyPer?.toNumber() ?? null,
        uom: it.uom,
        mtc: it.materialIdentifications.map((m) => ({ id: m.id, heatNumber: m.heatNumber, mtcRef: m.mtcRef, pmiResult: m.pmiResult ?? "PENDING" })),
        procurement: summarizeProcurement(it.procurementEvents),
        components: it.components.map((c) => buildComponentSummary(c, checkpointsByProcessCode)),
        requiredQty: required?.toNumber() ?? null,
        availableQty: available?.toNumber() ?? null,
        shortage: shortageVal?.toNumber() ?? null,
      };
      const list = byGroup.get(groupName) ?? [];
      list.push(row);
      byGroup.set(groupName, list);
    }

    const groups: BomGroup[] = [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, groupItems]) => ({ name, items: groupItems }));

    const [welders, delayCategories] = await Promise.all([
      tx.welder.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      tx.delayCategoryRef.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    return {
      equipmentId: targetId,
      equipmentName: equipment.name,
      equipments,
      groups,
      subAssemblyComponents,
      units,
      unitId: targetUnitId,
      welders,
      delayCategories,
    };
  });
}

/**
 * B3, Phase 4: the required-quantity wrapper — loads the target `BomItem`'s
 * whole equipment tree once (thin DB call), then hands off to the pure
 * `explodeBomItem` for the actual walk-and-multiply. Nothing calls this yet;
 * a later dispatch (stock/shortage) is the first real caller.
 *
 * `unitCount` is the equipment's `Unit` row count (invariant: never a typed
 * literal) — e.g. 9 for DESPL-320's serials, derived from the DB, not passed
 * in.
 */
export async function requiredQty(actor: Actor, bomItemId: number): Promise<Decimal> {
  return withTenant(actor.tenantId, async (tx) => {
    const bomItem = await tx.bomItem.findUnique({
      where: { id: bomItemId },
      select: { equipmentId: true, equipment: { select: { job: { select: { clientId: true } } } } },
    });
    if (!bomItem) throw new AppError(ERROR_CODES.NOT_FOUND, { bomItemId });
    assertClientScope(actor, bomItem.equipment.job.clientId);

    const [unitCount, siblingItems] = await Promise.all([
      tx.unit.count({ where: { equipmentId: bomItem.equipmentId } }),
      tx.bomItem.findMany({
        where: { equipmentId: bomItem.equipmentId },
        select: { id: true, qtyPer: true, parentBomItemId: true },
      }),
    ]);

    const itemsById = new Map<number, ExplodableBomItem>(siblingItems.map((it) => [it.id, it]));
    const target = itemsById.get(bomItemId);
    if (!target) throw new AppError(ERROR_CODES.NOT_FOUND, { bomItemId });

    return explodeBomItem(target, unitCount, itemsById);
  });
}

/**
 * B6, Phase 4: on-hand quantity for a BOM item, derived from `StockLot` +
 * `StockTxn` — `sum(StockLot.qty) - sum(StockTxn.qty where ISSUE|SCRAP) +
 * sum(StockTxn.qty where RETURN)`. Same tenant-anchoring shape as
 * `requiredQty` (through `equipment.job`, since `bom_items` carries no
 * tenant_id of its own).
 *
 * Returns `null` — not `0` — when this BOM item has zero `StockLot` rows
 * (and by construction, zero `StockTxn` rows too, since a txn always belongs
 * to a lot for this item). This is the SEAM principle: "never tracked" must
 * stay silent, not render as "0 available".
 */
export async function availableQty(actor: Actor, bomItemId: number): Promise<Decimal | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const bomItem = await tx.bomItem.findFirst({
      where: { id: bomItemId, equipment: { job: { tenantId: actor.tenantId } } },
      select: { equipment: { select: { job: { select: { clientId: true } } } } },
    });
    if (!bomItem) throw new AppError(ERROR_CODES.NOT_FOUND, { bomItemId });
    assertClientScope(actor, bomItem.equipment.job.clientId);

    const lots = await tx.stockLot.findMany({
      where: { bomItemId },
      select: { qty: true, txns: { select: { type: true, qty: true } } },
    });
    if (lots.length === 0) return null;

    let total = lots.reduce((sum, lot) => sum.plus(lot.qty), new Decimal(0));
    for (const lot of lots) {
      for (const t of lot.txns) {
        total = t.type === "RETURN" ? total.plus(t.qty) : total.minus(t.qty);
      }
    }
    return total;
  });
}

/**
 * B6, Phase 4: `requiredQty - availableQty` — a negative result is surplus,
 * not hidden as 0 (display layer clamps for the "shortage" label, this
 * helper does not). Returns `null` whenever `availableQty` does — a BOM item
 * with no stock activity at all must never render a fabricated "fully
 * short" number.
 */
export async function shortage(actor: Actor, bomItemId: number): Promise<Decimal | null> {
  const [required, available] = await Promise.all([requiredQty(actor, bomItemId), availableQty(actor, bomItemId)]);
  if (available == null) return null;
  return required.minus(available);
}
