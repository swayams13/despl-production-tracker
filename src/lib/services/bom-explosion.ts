import { Decimal } from "@prisma/client/runtime/library";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

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
