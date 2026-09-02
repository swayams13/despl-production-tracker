import { Decimal } from "@prisma/client/runtime/library";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { StockTxnType } from "@/generated/prisma/client";

/** The minimal shape `explodeBomItem` needs — callers load a real `BomItem`
 * row (or a fixture) and pick these three fields off it. */
export interface ExplodableBomItem {
  id: number;
  qtyPer: Decimal | number | string | null;
  parentBomItemId: number | null;
}

/**
 * Pure BOM-tree qty explosion (Phase 4, B3). Walks `parentBomItemId` up to
 * the root, multiplying each level's `qtyPer` together, then × `unitCount`
 * (the equipment's `Unit` row count). No Prisma calls in here — the caller
 * (`bom.read.ts`'s `requiredQty`) loads the whole equipment's BomItem set
 * into `itemsById` once and passes it in, matching this codebase's
 * pure-core/thin-caller convention (`lib/schedule/envelope.ts`).
 *
 * A `qtyPer` of null (unparsed free-text source, e.g. "As required") is
 * treated as a hard stop — the caller passed in a row this function can't
 * multiply, so it throws rather than silently treating it as 0 or 1.
 */
export function explodeBomItem(
  bomItem: ExplodableBomItem,
  unitCount: number,
  itemsById: Map<number, ExplodableBomItem>,
): Decimal {
  let total = new Decimal(1);
  let current: ExplodableBomItem | undefined = bomItem;
  const visited = new Set<number>();

  while (current) {
    if (visited.has(current.id)) {
      throw new AppError(ERROR_CODES.BOM_CYCLE_DETECTED, { bomItemId: bomItem.id, cycleAt: current.id });
    }
    visited.add(current.id);

    if (current.qtyPer == null) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { bomItemId: bomItem.id, unparsedAt: current.id },
        `BomItem ${current.id} has no parsed qtyPer — cannot explode a required quantity through it.`,
      );
    }
    total = total.times(current.qtyPer);

    current = current.parentBomItemId == null ? undefined : itemsById.get(current.parentBomItemId);
  }

  return total.times(unitCount);
}

/** The minimal shape the shortage-relevant availability calc needs off a
 * `StockLot` (+ its `StockTxn`s) — callers pick these fields off a real row. */
export interface StockLotForAvailability {
  qty: Decimal | number | string;
  txns: { type: StockTxnType; qty: Decimal | number | string }[];
}

/**
 * Fix wave, Phase 4 (Critical #1): the single, shared "how much of this BOM
 * item's kit is actually available for the gate/shortage number" calc.
 * Previously hand-copied in three places (`bom.read.ts`'s `loadBomTree` and
 * `availableQty`, `_shared.ts`'s `assertKitReady`) with wrong arithmetic —
 * `ISSUE` was subtracted, which meant issuing material to production (the
 * normal, correct action) manufactured a false shortage against the very
 * component it was issued to.
 *
 * `ISSUE` and `RETURN` do NOT move this number: issuing material into the
 * product is consumption as intended, not loss — it must not read as "less
 * available" for kit-readiness purposes. Only `SCRAP` is a real deduction
 * from what was received (material that will never make it into a unit).
 * (`RETURN`'s physical on-hand effect, if ever surfaced as a separate
 * concern from shortage, lives in `stock.service.ts`'s own per-lot
 * available-to-issue check — untouched by this fix.)
 *
 * Returns `null` — not `0` — when there are zero lots: the SEAM principle,
 * "never tracked" must stay silent, not render as "0 available"/"fully
 * short".
 */
export function computeAvailableForShortage(lots: StockLotForAvailability[]): Decimal | null {
  if (lots.length === 0) return null;
  let available = lots.reduce((sum, lot) => sum.plus(lot.qty), new Decimal(0));
  for (const lot of lots) {
    for (const t of lot.txns) {
      if (t.type === "SCRAP") available = available.minus(t.qty);
    }
  }
  return available;
}
