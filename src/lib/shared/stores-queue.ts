import type { MaterialFacts } from "./job-materials";

/**
 * Lean Core L2.14: what Stores has to do for a BOM line. Pure: the same facts the
 * Materials pipeline uses, plus how many received lots carry no heat number.
 * A line can need more than one thing (received, not identified, not issued).
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

export function storesNeeds(f: MaterialFacts, lotsWithoutHeat: number): StoresNeed[] {
  const needs: StoresNeed[] = [];
  // Expected: a PO is placed and the quantity is not all in.
  if (f.poPlaced && !receivedInFull(f)) needs.push("receive");
  // Something is in, but no heat number or MTC has been recorded against the line.
  if (f.anyReceipt && f.heats.length === 0) needs.push("identify");
  // Something is in and not all of it is issued.
  if (f.anyReceipt && !issuedInFull(f)) needs.push("issue");
  if (lotsWithoutHeat > 0) needs.push("heat");
  return needs;
}
