/**
 * Lean Core L2.8 (frame 07B): the Materials pipeline. Pure: facts in, five
 * chips (Indent, PO, Received, Identified, Issued) and a status out. The read
 * (`job-materials.read.ts`) gathers the facts; nothing here touches the DB.
 */

export const PIPELINE_STEPS = [
  { key: "indent", label: "Indent" },
  { key: "po", label: "PO" },
  { key: "received", label: "Received" },
  { key: "identified", label: "Identified" },
  { key: "issued", label: "Issued" },
] as const;
export type PipelineKey = (typeof PIPELINE_STEPS)[number]["key"];
export type ChipState = "done" | "current" | "todo";

export interface MaterialFacts {
  /** Required over all units (explodeBomItem); null when the quantity is free text. */
  requiredQty: number | null;
  /** Latest indent stage seen: an INDENT_RAISED / INDENT_APPROVED event. */
  indent: "raised" | "approved" | null;
  poPlaced: boolean;
  /** Any RECEIPT event or any stock lot. */
  anyReceipt: boolean;
  /** Received quantity when known (stock lots, else known receipts); null = unknown or none. */
  receivedQty: number | null;
  /** Heat numbers recorded against the line (MaterialIdentification). */
  heats: string[];
  /** ISSUE minus RETURN. */
  issuedQty: number;
  /** ISO date by which the first process that uses it starts; null = not derivable. */
  neededBy: string | null;
}

export interface PipelineChip {
  key: PipelineKey;
  label: string;
  state: ChipState;
  detail: string | null;
  /** The current step cannot finish in time (red). */
  late: boolean;
}

type Level = "none" | "partial" | "full";

const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function levels(f: MaterialFacts): Level[] {
  const need = f.requiredQty;
  const received: Level = !f.anyReceipt
    ? "none"
    : f.receivedQty == null || need == null || f.receivedQty >= need
      ? "full"
      : "partial";
  const issued: Level = f.issuedQty <= 0 ? "none" : need == null || f.issuedQty >= need ? "full" : "partial";
  return [f.indent ? "full" : "none", f.poPlaced ? "full" : "none", received, f.heats.length > 0 ? "full" : "none", issued];
}

/** Steps up to the last completed one are done (material can be issued from old stock with no PO logged), the next is current. */
function reached(f: MaterialFacts): number {
  const lv = levels(f);
  let r = -1;
  lv.forEach((l, i) => {
    if (l === "full") r = i;
  });
  return r;
}

/** Due within 7 days or already past, and the material is not all here. */
export function isShortThisWeek(f: MaterialFacts, now: Date): boolean {
  if (!f.neededBy) return false;
  const lv = levels(f);
  if (lv[2] === "full" || lv[4] === "full") return false;
  return new Date(f.neededBy).getTime() - now.getTime() <= 7 * 864e5;
}

export function derivePipeline(f: MaterialFacts, now: Date): PipelineChip[] {
  const lv = levels(f);
  const r = reached(f);
  const late = isShortThisWeek(f, now);
  const detail = (i: number): string | null => {
    switch (PIPELINE_STEPS[i].key) {
      case "indent":
        return f.indent;
      case "po":
        return f.poPlaced ? "placed" : null;
      case "received":
        return lv[2] === "partial" ? `${f.receivedQty == null ? "some" : num(f.receivedQty)} of ${num(f.requiredQty!)}` : null;
      case "identified":
        return f.heats.length === 0 ? null : f.heats.length === 1 ? f.heats[0] : `${f.heats[0]} +${f.heats.length - 1}`;
      case "issued":
        return lv[4] === "partial" ? `${num(f.issuedQty)} of ${num(f.requiredQty!)}` : null;
    }
  };
  return PIPELINE_STEPS.map((s, i) => {
    const state: ChipState = i <= r ? "done" : i === r + 1 ? "current" : "todo";
    return { key: s.key, label: s.label, state, detail: state === "todo" ? null : detail(i), late: state === "current" && late };
  });
}

export type MaterialStatus = "issued" | "ready_to_issue" | "short" | "on_track" | "not_started";

export function materialStatus(f: MaterialFacts, now: Date): { status: MaterialStatus; label: string } {
  const r = reached(f);
  if (r === 4) return { status: "issued", label: "Issued" };
  if (isShortThisWeek(f, now)) {
    const past = new Date(f.neededBy!).getTime() < now.getTime();
    return { status: "short", label: past ? "Short, needed date has passed" : "Short for work starting this week" };
  }
  if (r === 3) return { status: "ready_to_issue", label: "Ready to issue" };
  if (r < 0 && !f.anyReceipt && f.issuedQty <= 0) return { status: "not_started", label: "Not started" };
  return { status: "on_track", label: "On track" };
}
