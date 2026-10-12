import type { DryRunReport } from "@/lib/services/master-import.service";

/**
 * Pure model for the import screen: plain-English issue titles, grouping, the
 * CSV for the DESPL team, and the reasons Confirm is unavailable. No React.
 */
export type Issue = DryRunReport["issues"][number];
export type Severity = "ERROR" | "WARNING" | "INFO";

/** Every issue code the importer can raise, in plain English (a test keeps this list complete). */
export const ISSUE_TITLES: Record<string, string> = {
  SHEET_MISSING: "A sheet is missing from the workbook",
  COLUMN_MISSING: "A column is missing from a sheet",
  INVALID_VALUE: "A value is not valid",
  DUPLICATE_PART_CODE: "A part code appears more than once",
  NOT_APPROVED: "Part is not marked approved",
  ASSUMED_ROUTE_APPROVED: "Marked approved, but the route source is still assumed",
  UNKNOWN_RAW_FORM: "Raw material form has no tracker type",
  UNKNOWN_PART: "A route is for a part that is not in the Parts Master",
  UNKNOWN_OPERATION: "Operation is not in the approved operation list",
  UNKNOWN_DEPARTMENT: "Department is not a tracker department",
  MISSING_DEPARTMENT: "Step has no department",
  MISSING_STAGE: "Step has no stage number",
  UNKNOWN_STAGE_NUMBER: "Stage number does not exist",
  DUPLICATE_STEP: "A step number is used twice",
  UNKNOWN_TIME_BASIS: "Time basis is not recognised",
  MISSING_STD_TIME: "Step has no standard time",
  PROPOSED_STD_TIME: "Standard time is only proposed",
  STAGE_DIFFERS_FROM_OPERATION_DEFAULT: "Stage differs from where this operation normally counts",
  DEPARTMENT_STAGE_MISMATCH: "Step department differs from the stage's department",
  POSSIBLE_FILL_DOWN: "Stages look copied down (Fit-up 19, Welding 20, Inspection 21)",
  PART_WITHOUT_ROUTE: "Part has no route",
  VARIANT_GAP: "Route variants do not match what the part declares",
  DUPLICATE_MATERIAL: "A material appears more than once",
  MISSING_DENSITY: "Material has no density",
  DUPLICATE_STAGE: "A heat-exchanger stage appears more than once",
  UNKNOWN_PREDECESSOR: "A heat-exchanger stage names a predecessor that does not exist",
  ASSEMBLY_UNKNOWN_PART: "An assembly step uses a part that is not in the Parts Master",
  NEW_OPERATION_PENDING: "A new operation is proposed and needs a decision",
  REVIEW_ACTION_OPEN: "An open review question from the workbook",
  PART_CODE_CONFLICT: "Part code is already used by another component type",
  STATUS_DOWNGRADE: "Part is already approved and the workbook says otherwise",
  MATERIAL_LOCKED: "Material is already reviewed or approved",
};

export const titleOf = (code: string): string => ISSUE_TITLES[code] ?? code;

export interface IssueGroup {
  code: string;
  title: string;
  severity: Severity;
  count: number;
  issues: Issue[];
}

const ORDER: Record<string, number> = { ERROR: 0, WARNING: 1, INFO: 2 };

/** One group per code, errors first, then by size; optionally only some severities. */
export function groupIssues(issues: readonly Issue[], only?: ReadonlySet<Severity>): IssueGroup[] {
  const by = new Map<string, IssueGroup>();
  for (const i of issues) {
    if (only && only.size > 0 && !only.has(i.severity as Severity)) continue;
    const g = by.get(i.code) ?? { code: i.code, title: titleOf(i.code), severity: i.severity as Severity, count: 0, issues: [] };
    g.count++;
    g.issues.push(i);
    by.set(i.code, g);
  }
  return [...by.values()].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.count - a.count || a.code.localeCompare(b.code));
}

export function severityCounts(issues: readonly Issue[]): Record<Severity, number> {
  const out: Record<Severity, number> = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const i of issues) out[i.severity as Severity]++;
  return out;
}

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The issue list for the DESPL team to fix the workbook from. */
export function issuesToCsv(issues: readonly Issue[]): string {
  const head = ["Severity", "What", "Code", "Sheet", "Row", "Part", "Detail"];
  const rows = issues.map((i) => [i.severity, titleOf(i.code), i.code, i.sheet, i.row, i.partCode ?? "", i.message]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

type Plan = DryRunReport["plan"];

/** True when applying this plan would change nothing. */
export function nothingToWrite(plan: Plan): boolean {
  const t = (x: { create: number; update: number }) => x.create + x.update;
  return (
    t(plan.partFamilies) === 0 &&
    t(plan.routes) === 0 &&
    t(plan.materialGrades) === 0 &&
    (plan.heStages.outcome === "unchanged" || plan.heStages.outcome === "skipped")
  );
}

/** What apply would write, in a sentence ("Load 40 grades and HE stages"). */
export function whatWillLoad(plan: Plan): string {
  const parts: string[] = [];
  const n = (x: { create: number; update: number }) => x.create + x.update;
  if (n(plan.partFamilies) > 0) parts.push(`${n(plan.partFamilies)} part famil${n(plan.partFamilies) === 1 ? "y" : "ies"}`);
  if (n(plan.routes) > 0) parts.push(`${n(plan.routes)} route${n(plan.routes) === 1 ? "" : "s"}`);
  if (n(plan.materialGrades) > 0) parts.push(`${n(plan.materialGrades)} material grade${n(plan.materialGrades) === 1 ? "" : "s"}`);
  if (plan.heStages.outcome === "create" || plan.heStages.outcome === "update") parts.push("the heat-exchanger stage list");
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

/** Why "Load into tracker" is unavailable, in words; null when it is available. */
export function confirmBlockedReason(args: { report: DryRunReport; canApply: boolean; isHead: boolean }): string | null {
  const { report, canApply, isHead } = args;
  const structural = report.issues.filter((i) => i.code === "SHEET_MISSING" || i.code === "COLUMN_MISSING");
  if (structural.length > 0) {
    return `This workbook is missing something the importer needs: ${[...new Set(structural.map((i) => i.message))].join(" ")}`;
  }
  if (!canApply) return "Only the Production Head and Admins can load a workbook. You can check it and fix the file.";
  // Mirrors apply: any loadable approved part (even an unchanged one) needs the Production Head.
  if (!isHead && report.parts.some((p) => p.status === "APPROVED" && p.outcome !== "skipped")) {
    return "This file has approved parts. Only the Production Head can load them; ask SJ to run this import.";
  }
  if (nothingToWrite(report.plan)) return "Nothing in this file would change anything: it already matches the tracker.";
  return null;
}

/** Banner for a part tally that loads no part at all while the rest still loads. */
export function noPartLoads(report: DryRunReport): boolean {
  const t = report.plan.partFamilies;
  return report.counts.parts > 0 && t.create + t.update + t.unchanged === 0;
}
