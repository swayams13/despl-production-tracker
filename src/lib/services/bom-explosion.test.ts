import { describe, expect, it } from "vitest";
import {
  explodeBomItem,
  computeAvailableForShortage,
  computeAvailableToIssue,
  type ExplodableBomItem,
  type StockLotForAvailability,
} from "./bom-explosion";
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

/**
 * Pure — no DB. Fix wave (Critical #1): the single shared shortage-relevant
 * availability calc — `sum(lot.qty) - sum(SCRAP txns)`. ISSUE and RETURN
 * must NOT move this number: issuing material into the product is
 * consumption as intended, not loss. The bug this replaces subtracted ISSUE,
 * which meant issuing a full kit's material to production manufactured a
 * false shortage against the very component it was issued to.
 */
describe("computeAvailableForShortage", () => {
  it("zero lots → null (SEAM: never tracked, distinct from zero available)", () => {
    expect(computeAvailableForShortage([])).toBeNull();
  });

  it("no txns at all: available is just the received quantity", () => {
    const lots: StockLotForAvailability[] = [{ qty: 9, txns: [] }];
    expect(computeAvailableForShortage(lots)!.toNumber()).toBe(9);
  });

  it("ISSUE does not reduce availability — the regression this fix wave exists for", () => {
    const lots: StockLotForAvailability[] = [{ qty: 9, txns: [{ type: "ISSUE", qty: 9 }] }];
    expect(computeAvailableForShortage(lots)!.toNumber()).toBe(9);
  });

  it("RETURN does not increase availability either (nothing to add back to a number ISSUE never reduced)", () => {
    const lots: StockLotForAvailability[] = [
      { qty: 9, txns: [{ type: "ISSUE", qty: 4 }, { type: "RETURN", qty: 4 }] },
    ];
    expect(computeAvailableForShortage(lots)!.toNumber()).toBe(9);
  });

  it("SCRAP is the only real deduction from what was received", () => {
    const lots: StockLotForAvailability[] = [{ qty: 9, txns: [{ type: "SCRAP", qty: 2 }] }];
    expect(computeAvailableForShortage(lots)!.toNumber()).toBe(7);
  });

  it("multiple lots and mixed txn types sum correctly", () => {
    const lots: StockLotForAvailability[] = [
      { qty: 9, txns: [{ type: "ISSUE", qty: 1 }, { type: "SCRAP", qty: 1 }] },
      { qty: 5, txns: [{ type: "RETURN", qty: 2 }] }, // RETURN with no prior ISSUE on this lot — still a no-op
    ];
    // (9 - 1 SCRAP) + (5 - 0) = 8 + 5 = 13
    expect(computeAvailableForShortage(lots)!.toNumber()).toBe(13);
  });
});

/**
 * Pure — no DB. AUD-032: the gate-specific counterpart to
 * `computeAvailableForShortage` — this one DOES net ISSUE (and adds back
 * RETURN), because a gate deciding "is there still material to start this
 * work" must reflect what has actually been consumed since receipt, unlike
 * a display showing a lot's remaining quantity.
 */
describe("computeAvailableToIssue", () => {
  it("zero lots → null (same SEAM convention as computeAvailableForShortage)", () => {
    expect(computeAvailableToIssue([])).toBeNull();
  });

  it("a lot with qty=10, one ISSUE of 3 → 7", () => {
    const lots: StockLotForAvailability[] = [{ qty: 10, txns: [{ type: "ISSUE", qty: 3 }] }];
    expect(computeAvailableToIssue(lots)!.toNumber()).toBe(7);
  });

  it("a lot with qty=10, ISSUE of 3, RETURN of 1 → 8", () => {
    const lots: StockLotForAvailability[] = [
      { qty: 10, txns: [{ type: "ISSUE", qty: 3 }, { type: "RETURN", qty: 1 }] },
    ];
    expect(computeAvailableToIssue(lots)!.toNumber()).toBe(8);
  });

  it("a lot with qty=10, SCRAP of 2, ISSUE of 3 → 5", () => {
    const lots: StockLotForAvailability[] = [
      { qty: 10, txns: [{ type: "SCRAP", qty: 2 }, { type: "ISSUE", qty: 3 }] },
    ];
    expect(computeAvailableToIssue(lots)!.toNumber()).toBe(5);
  });
});
