import type { StageDisplayStatus } from "@/components/industrial/stage-status";

/** Plain-English labels for the master-data enums (CLAUDE.md: never show a raw enum). */
export const SCOPE_LABEL: Record<string, string> = { PV: "PV", HE: "HE", BOTH: "PV + HE" };

export const MAKE_BUY_LABEL: Record<string, string> = {
  MADE_IN_HOUSE: "Made in-house",
  BOUGHT_MACHINED: "Bought + machined in-house",
  BOUGHT_OUT: "Bought-out",
  BOUGHT_FABRICATED: "Bought + fabricated in-house",
};

export const UNIT_LABEL: Record<string, string> = { HOURS: "h", DAYS: "d" };

export const BASIS_LABEL: Record<string, string> = {
  PER_PIECE: "per piece",
  PER_JOB: "per job",
  PER_MATERIAL_LOT: "per material lot",
  PER_METRE_CUT: "per metre of cut",
  PER_METRE_EDGE: "per metre of edge",
  PER_METRE_WELD: "per metre of weld",
  PER_JOINT: "per joint",
  PER_HOLE: "per hole",
  PER_TUBE: "per tube",
  PER_KG: "per kg",
};

export const BASIS_OPTIONS = Object.entries(BASIS_LABEL).map(([value, label]) => ({ value, label }));

export const FIELD_LABEL: Record<string, string> = {
  operation: "Operation",
  department: "Department",
  pvStage: "PV stage",
  heStage: "HE stage",
  stdTime: "Time",
  seq: "Step",
  stdTimeUnit: "Time unit",
  stdTimeBasis: "Time basis",
};

export function partStatus(status: string): { status: StageDisplayStatus; label: string } {
  if (status === "APPROVED") return { status: "complete", label: "Approved" };
  if (status === "REVIEWED") return { status: "submitted", label: "Reviewed" };
  return { status: "idle", label: "Draft" };
}

export function versionStatus(status: string): { status: StageDisplayStatus; label: string } {
  if (status === "PUBLISHED") return { status: "complete", label: "Published" };
  if (status === "ARCHIVED") return { status: "idle", label: "Archived" };
  return { status: "idle", label: "Draft" };
}

/** "0.5 h per piece", or an em dash when no time is recorded. */
export function formatTime(time: number | null, unit: string | null, basis: string | null): string {
  if (time == null) return "—";
  return `${time} ${UNIT_LABEL[unit ?? ""] ?? ""} ${BASIS_LABEL[basis ?? ""] ?? ""}`.replace(/\s+/g, " ").trim();
}
