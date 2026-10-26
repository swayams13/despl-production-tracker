import { describe, expect, it } from "vitest";
import { parseImportRow } from "./bom.service";

describe("parseImportRow (shared by the BOM panel import and the wizard upload)", () => {
  it.each([
    ["no part name", { "Item No": 1, "Part Name": "", Qty: 1 }, /Part name is required/],
    ["a part name of spaces", { "Item No": 1, "Part Name": "  ", Qty: 1 }, /Part name is required/],
    ["no quantity", { "Item No": 1, "Part Name": "Shell", Qty: "" }, /Quantity is required/],
    ["an item no that is not a number", { "Item No": "x", "Part Name": "Shell", Qty: 1 }, /^Item no must be a number above zero$/],
    ["an item no of zero", { "Item No": 0, "Part Name": "Shell", Qty: 1 }, /^Item no must be a number above zero$/],
    ["a quantity per unit of text", { "Item No": 1, "Part Name": "Shell", Qty: 1, "Qty Per": "many" }, /^Quantity per unit must be a number above zero$/],
  ])("refuses a row with %s", (_n, raw, message) => {
    const r = parseImportRow(raw);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(message);
  });

  it("reads a row through the header aliases and ignores columns it does not know", () => {
    const r = parseImportRow({ "S. No": "2", "Part-Name": "Dish end", Quantity: 2, Material: "SA 516", "Drawing ref": "D-1" });
    expect(r).toEqual({ ok: true, data: { itemNo: 2, partName: "Dish end", sourceQty: "2", material: "SA 516" } });
  });

  it("treats a blank optional cell as no value instead of refusing the row", () => {
    const r = parseImportRow({ "Item No": 1, "Part Name": "Shell", Qty: 1, Material: "", Remarks: "   ", "Component Type": "" });
    expect(r).toEqual({ ok: true, data: { itemNo: 1, partName: "Shell", sourceQty: "1" } });
  });
});
