import { describe, expect, it } from "vitest";
import { explodeBomItem, type ExplodableBomItem } from "./bom-explosion";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/** Pure — no DB. B3's qty-explosion walk: parentBomItemId up to the root,
 * multiplying qtyPer at each level, then × unitCount. */
describe("explodeBomItem", () => {
  it("flat item (no parent): qtyPer=4 × unitCount=9 = 36", () => {
    const item: ExplodableBomItem = { id: 1, qtyPer: 4, parentBomItemId: null };
    const itemsById = new Map<number, ExplodableBomItem>([[1, item]]);
    expect(explodeBomItem(item, 9, itemsById).toNumber()).toBe(36);
  });

  it("nested 2-level item: bolt(qtyPer=4) inside sub-assembly(qtyPer=2) inside top(qtyPer=1) × unitCount=9 = 4 × 2 × 1 × 9 = 72", () => {
    const top: ExplodableBomItem = { id: 1, qtyPer: 1, parentBomItemId: null };
    const subAssembly: ExplodableBomItem = { id: 2, qtyPer: 2, parentBomItemId: 1 };
    const bolt: ExplodableBomItem = { id: 3, qtyPer: 4, parentBomItemId: 2 };
    const itemsById = new Map<number, ExplodableBomItem>([
      [1, top],
      [2, subAssembly],
      [3, bolt],
    ]);
    expect(explodeBomItem(bolt, 9, itemsById).toNumber()).toBe(4 * 2 * 1 * 9);
    expect(explodeBomItem(bolt, 9, itemsById).toNumber()).toBe(72);
  });

  it("cycle guard: a malformed A→B→A parentBomItemId chain throws BOM_CYCLE_DETECTED rather than looping forever", () => {
    const a: ExplodableBomItem = { id: 1, qtyPer: 1, parentBomItemId: 2 };
    const b: ExplodableBomItem = { id: 2, qtyPer: 1, parentBomItemId: 1 };
    const itemsById = new Map<number, ExplodableBomItem>([
      [1, a],
      [2, b],
    ]);
    expect(() => explodeBomItem(a, 9, itemsById)).toThrow(AppError);
    try {
      explodeBomItem(a, 9, itemsById);
      throw new Error("expected explodeBomItem to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);
    }
  });

  it("throws on a null qtyPer anywhere in the chain, rather than silently guessing a multiplier", () => {
    const top: ExplodableBomItem = { id: 1, qtyPer: null, parentBomItemId: null };
    const itemsById = new Map<number, ExplodableBomItem>([[1, top]]);
    expect(() => explodeBomItem(top, 9, itemsById)).toThrow(AppError);
  });
});
