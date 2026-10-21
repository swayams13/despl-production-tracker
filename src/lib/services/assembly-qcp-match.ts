// Dependency-free except for the template resolver (relative imports only).
// The ONE place that decides which QCP item an INSPECTION assembly step binds
// to: materialiseAssemblyStepsFromTemplate (createJob) and the wizard's
// compatibility check (loadIntakeOptions) both call it, so they cannot drift.
import type { Prisma } from "../../generated/prisma/client";
import { resolveAssemblyTemplateVersion } from "./assembly-template.resolve";

export interface MatchStep {
  id: number;
  kind: string;
  srNo: string | null;
}
/** id null = a checkpoint a rule dropped from the job's QCP; it keeps its place in the order. */
export interface MatchQcpItem {
  id: number | null;
  srNo: string;
  sequence: number;
}

/** 0-based index of each step within its own srNo group, in template step order (over the FULL template). */
export function srNoOccurrences(steps: MatchStep[]): Map<number, number> {
  const out = new Map<number, number>();
  const counters = new Map<string, number>();
  for (const st of steps) {
    if (!st.srNo) continue;
    const idx = counters.get(st.srNo) ?? 0;
    out.set(st.id, idx);
    counters.set(st.srNo, idx + 1);
  }
  return out;
}

export function groupQcpBySrNo(items: MatchQcpItem[]): Map<string, MatchQcpItem[]> {
  const out = new Map<string, MatchQcpItem[]>();
  for (const item of [...items].sort((a, b) => a.sequence - b.sequence)) {
    out.set(item.srNo, [...(out.get(item.srNo) ?? []), item]);
  }
  return out;
}

/**
 * The QCP item an INSPECTION step binds to: `null` when the step needs no
 * binding (not an inspection, or no srNo), `"MISSING"` when it needs one and
 * the QCP has none at that occurrence (or a rule dropped it).
 */
export function matchInspectionStep(
  step: MatchStep,
  occurrence: Map<number, number>,
  qcpBySrNo: Map<string, MatchQcpItem[]>,
): MatchQcpItem | null | "MISSING" {
  if (step.kind !== "INSPECTION" || !step.srNo) return null;
  const match = qcpBySrNo.get(step.srNo)?.[occurrence.get(step.id) ?? 0];
  return !match || match.id == null ? "MISSING" : match;
}

/** Inspection srNos of the template that the QCP items cannot satisfy. */
export function unresolvedInspectionSrNos(steps: MatchStep[], qcpItems: MatchQcpItem[]): string[] {
  const occ = srNoOccurrences(steps);
  const grouped = groupQcpBySrNo(qcpItems);
  return [...new Set(steps.filter((st) => matchInspectionStep(st, occ, grouped) === "MISSING").map((st) => st.srNo!))];
}

/**
 * For each QCP template, the inspection srNos that some published assembly
 * template of the family (the family-level one, and each equipment type's) would
 * fail to bind. Empty list = compatible. A step a config rule later drops is still
 * counted, so this errs on the side of warning (createJob stays the authority).
 */
export async function qcpAssemblyGaps(
  tx: Prisma.TransactionClient,
  tenantId: number,
  familyId: number,
  equipmentTypeIds: number[],
  qcpTemplateIds: number[],
): Promise<Record<number, string[]>> {
  const out: Record<number, string[]> = Object.fromEntries(qcpTemplateIds.map((id) => [id, []]));
  const versions = new Map<number, Awaited<ReturnType<typeof resolveAssemblyTemplateVersion>>>();
  for (const typeId of [null, ...equipmentTypeIds]) {
    const v = await resolveAssemblyTemplateVersion(tx, tenantId, familyId, typeId);
    if (v) versions.set(v.id, v);
  }
  if (versions.size === 0 || qcpTemplateIds.length === 0) return out;
  const items = await tx.qcpItem.findMany({
    where: { qcpTemplateId: { in: qcpTemplateIds } },
    select: { id: true, srNo: true, sequence: true, qcpTemplateId: true },
  });
  for (const qcpId of qcpTemplateIds) {
    const own = items.filter((i) => i.qcpTemplateId === qcpId);
    const gaps = new Set<string>();
    for (const v of versions.values()) for (const s of unresolvedInspectionSrNos(v!.steps, own)) gaps.add(s);
    out[qcpId] = [...gaps];
  }
  return out;
}
