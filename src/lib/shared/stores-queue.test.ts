import { describe, expect, it } from "vitest";
import type { MaterialFacts } from "./job-materials";
import { inLabel, storesNeeds } from "./stores-queue";

const facts = (over: Partial<MaterialFacts> = {}): MaterialFacts => ({
  requiredQty: 10, indent: "approved", poPlaced: true, anyReceipt: false, receivedQty: null, heats: [], issuedQty: 0, neededBy: null, ...over,
});

describe("L2.14 what Stores has to do for a line", () => {
  it.each<[string, Partial<MaterialFacts>, number, string[]]>([
    ["a PO is placed and nothing is in", {}, 0, ["receive"]],
    ["nothing ordered yet is Procurement's, not Stores'", { poPlaced: false, indent: "raised" }, 0, []],
    ["part of it is in: still to receive, and only there (not also identify or issue)", { anyReceipt: true, receivedQty: 4 }, 0, ["receive"]],
    ["all in, nothing identified yet: identify only, not also issue", { anyReceipt: true, receivedQty: 10 }, 0, ["identify"]],
    ["all in, identified, nothing issued", { anyReceipt: true, receivedQty: 10, heats: ["H-1"] }, 0, ["issue"]],
    ["all in and identified, part issued", { anyReceipt: true, receivedQty: 10, heats: ["H-1"], issuedQty: 6 }, 0, ["issue"]],
    ["all issued: nothing left to do", { anyReceipt: true, receivedQty: 10, heats: ["H-1"], issuedQty: 10 }, 0, []],
    ["a lot with no heat number is its own item once the line is otherwise done", { anyReceipt: true, receivedQty: 10, heats: ["H-1"], issuedQty: 10 }, 2, ["heat"]],
    ["a lot with no heat number does not repeat a line that still has an earlier stage", { anyReceipt: true, receivedQty: 10, heats: ["H-1"] }, 2, ["issue"]],
    ["unknown quantity: a receipt counts as in, any issue as issued", { requiredQty: null, anyReceipt: true, receivedQty: null, heats: ["H-1"], issuedQty: 1 }, 0, []],
    ["unknown quantity, nothing issued yet", { requiredQty: null, anyReceipt: true, heats: ["H-1"] }, 0, ["issue"]],
    ["issued from old stock with no PO logged is not to receive", { poPlaced: false, anyReceipt: true, receivedQty: 10, heats: ["H-1"], issuedQty: 3 }, 0, ["issue"]],
  ])("%s", (_name, over, noHeat, expected) => {
    expect(storesNeeds(facts(over), noHeat)).toEqual(expected);
  });
});

describe("the In column agrees with the Received status", () => {
  it.each<[string, Partial<MaterialFacts>, string]>([
    ["nothing in", {}, "—"],
    ["quantity known", { anyReceipt: true, receivedQty: 4 }, "4"],
    ["fractional quantity", { anyReceipt: true, receivedQty: 2.5 }, "2.5"],
    ["a receipt was recorded without a quantity: not a dash", { anyReceipt: true, receivedQty: null }, "in"],
  ])("%s", (_n, over, label) => {
    expect(inLabel(facts(over))).toBe(label);
  });
});
