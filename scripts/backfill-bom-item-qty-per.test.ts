import { describe, expect, it } from "vitest";
import { parseSourceQty } from "./backfill-bom-item-qty-per";

/**
 * Pure regex test — no DB. Fixtures are the exact examples named in the B1
 * task brief, resembling the live-CSV shape (`BomItem.sourceQty`'s doc
 * comment: "the live CSVs carry things like \"40 NOS.\"").
 */
describe("parseSourceQty", () => {
  it("parses a whole number with a trailing UOM", () => {
    expect(parseSourceQty("40 NOS.")).toEqual({ qtyPer: 40, uom: "NOS." });
  });

  it("parses a singular quantity with a trailing UOM", () => {
    expect(parseSourceQty("1 NO.")).toEqual({ qtyPer: 1, uom: "NO." });
  });

  it("returns null for free text with no leading number — never guessed", () => {
    expect(parseSourceQty("As required")).toBeNull();
  });

  it("parses a bare number with no UOM as uom: null", () => {
    expect(parseSourceQty("24")).toEqual({ qtyPer: 24, uom: null });
  });
});
