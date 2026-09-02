import { describe, expect, it } from "vitest";
import { formatBomQty } from "./bom-format";

/** Pure — no DB. B1's quantity cell: parsed `qtyPer`/`uom` renders numeric, an
 * unparsed row falls back to the raw `sourceQty` string and never throws. */
describe("formatBomQty", () => {
  it("renders qtyPer + uom when parsed", () => {
    expect(formatBomQty({ qtyPer: 40, uom: "NOS.", sourceQty: "40 NOS." })).toBe("40 NOS.");
  });

  it("renders a bare qtyPer when there's no uom", () => {
    expect(formatBomQty({ qtyPer: 24, uom: null, sourceQty: "24" })).toBe("24");
  });

  it("falls back to the raw sourceQty when unparsed, without throwing", () => {
    expect(formatBomQty({ qtyPer: null, uom: null, sourceQty: "As required" })).toBe("As required");
  });
});
