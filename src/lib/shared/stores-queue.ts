import type { MaterialFacts } from "./job-materials";

/**
 * Lean Core L2.14: what Stores has to do for a BOM line. Pure: the same facts the
 * Materials pipeline uses, plus how many received lots carry no heat number.
 * A line sits in exactly one group, the earliest stage of the pipeline it has not
 * finished (receive, then identify, then issue; a lot with no heat number only once the
 * line is otherwise done). Before this, a part-received line showed under all three.
 * Needed-by dates are not derivable across jobs until J5, so nothing here is
 * ranked by date.
 */
export type StoresNeed = "receive" | "identify" | "issue" | "heat";

export const NEED_LABEL: Record<StoresNeed, string> = {
  receive: "To receive",
  identify: "To identify",
  issue: "To issue",
  heat: "No heat number",
};
export const NEED_ORDER: readonly StoresNeed[] = ["receive", "identify", "issue", "heat"];

const receivedInFull = (f: MaterialFacts): boolean =>
  f.anyReceipt && (f.receivedQty == null || f.requiredQty == null || f.receivedQty >= f.requiredQty);
const issuedInFull = (f: MaterialFacts): boolean => (f.requiredQty == null ? f.issuedQty > 0 : f.issuedQty >= f.requiredQty);

/** The one thing Stores has to do next for the line, as a list of zero or one. */
export function storesNeeds(f: MaterialFacts, lotsWithoutHeat: number): StoresNeed[] {
  // Expected: a PO is placed and the quantity is not all in.
  if (f.poPlaced && !receivedInFull(f)) return ["receive"];
  // Something is in, but no heat number or MTC has been recorded against the line.
  if (f.anyReceipt && f.heats.length === 0) return ["identify"];
  // Something is in and not all of it is issued.
  if (f.anyReceipt && !issuedInFull(f)) return ["issue"];
  return lotsWithoutHeat > 0 ? ["heat"] : [];
}

/** The In column: the quantity when known; "in" when a receipt is recorded without one (never "—" for a received line). */
export function inLabel(f: Pick<MaterialFacts, "anyReceipt" | "receivedQty">): string {
  if (f.receivedQty != null) return Number.isInteger(f.receivedQty) ? String(f.receivedQty) : f.receivedQty.toFixed(1);
  return f.anyReceipt ? "in" : "—";
}
