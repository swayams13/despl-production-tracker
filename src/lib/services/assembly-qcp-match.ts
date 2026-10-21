// Dependency-free except for the template resolver (relative imports only).
// The ONE place that decides which QCP item an INSPECTION assembly step binds
// to: materialiseAssemblyStepsFromTemplate (createJob) and the wizard's
// compatibility check (loadIntakeOptions) both call it, so they cannot drift.
import type { Prisma } from "../../generated/prisma/client";
import { AppError, ERROR_CODES } from "../shared/errors";
import { resolveAssemblyTemplateVersion } from "./assembly-template.resolve";

export interface MatchStep {
  id: number;
  kind: string;
  srNo: string | null;
  /** A step with a rule may be dropped per job, so it is not counted as unresolved here. */
  includeWhen?: unknown;
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

/**
 * Inspection srNos of the template that the QCP items cannot satisfy. Steps that
 * carry an includeWhen rule are skipped (a job's answers may drop them), but
 * still count toward occurrence numbering, exactly as createJob counts them.
 */
export function unresolvedInspectionSrNos(steps: MatchStep[], qcpItems: MatchQcpItem[]): string[] {
  const occ = srNoOccurrences(steps);
  const grouped = groupQcpBySrNo(qcpItems);
  return [...new Set(steps.filter((st) => st.includeWhen == null && matchInspectionStep(st, occ, grouped) === "MISSING").map((st) => st.srNo!))];
}

/** The items of each QCP template, loaded once for every family's check. */
export async function loadQcpItemsByTemplate(
  tx: Prisma.TransactionClient,
  tenantId: number,
  qcpTemplateIds: number[],
): Promise<Map<number, MatchQcpItem[]>> {
  const out = new Map<number, MatchQcpItem[]>(qcpTemplateIds.map((id) => [id, []]));
  const items = await tx.qcpItem.findMany({
    where: { tenantId, qcpTemplateId: { in: qcpTemplateIds } },
    select: { id: true, srNo: true, sequence: true, qcpTemplateId: true },
  });
  for (const i of items) out.get(i.qcpTemplateId)?.push({ id: i.id, srNo: i.srNo, sequence: i.sequence });
  return out;
}

/**
 * For each QCP template, the inspection srNos that an assembly template a line of
 * this family can actually get would fail to bind: the template each equipment type
 * resolves to (its own, else the family's), or the family's when no type exists.
 * Empty list = no gap found. Steps with a rule are skipped, so this is a warning,
 * not a verdict: createJob stays the authority.
 */
export async function qcpAssemblyGaps(
  tx: Prisma.TransactionClient,
  tenantId: number,
  familyId: number,
  equipmentTypeIds: number[],
  itemsByQcp: Map<number, MatchQcpItem[]>,
): Promise<Record<number, string[]>> {
  const versions = new Map<number, NonNullable<Awaited<ReturnType<typeof resolveAssemblyTemplateVersion>>>>();
  for (const typeId of equipmentTypeIds.length > 0 ? equipmentTypeIds : [null]) {
    const v = await resolveAssemblyTemplateVersion(tx, tenantId, familyId, typeId);
    if (v) versions.set(v.id, v);
  }
  const out: Record<number, string[]> = {};
  for (const [qcpId, items] of itemsByQcp) {
    const gaps = new Set<string>();
    for (const v of versions.values()) for (const s of unresolvedInspectionSrNos(v.steps, items)) gaps.add(s);
    out[qcpId] = [...gaps];
  }
  return out;
}

export interface BindExistingResult {
  /** Steps that took a QCP item. */
  bound: number;
  /** Unbound inspection steps already started or finished: left alone, listed for the caller. */
  leftUnbound: { assemblyStepId: number; srNo: string; status: string }[];
}

/**
 * JG2: bind a job's EXISTING unbound inspection steps to a freshly attached QCP
 * with the same matcher createJob uses (srNo occurrence over the version's FULL
 * template). Only NOT_STARTED steps are bound; started or finished ones stay as
 * they are. A NOT_STARTED step the QCP cannot satisfy refuses, as at create.
 */
export async function bindExistingInspectionSteps(
  tx: Prisma.TransactionClient,
  jobId: number,
  qcpTemplateId: number,
  /** Items a rule dropped from the cloned QCP: they keep their place in the numbering. */
  skipped: { srNo: string; sequence: number }[],
): Promise<BindExistingResult> {
  const steps = await tx.assemblyStep.findMany({
    where: { jobId, qcpItemId: null, templateStep: { kind: "INSPECTION" } },
    select: { id: true, status: true, templateStepId: true, templateStep: { select: { versionId: true, srNo: true } } },
    orderBy: { id: "asc" },
  });
  const items = await tx.qcpItem.findMany({ where: { qcpTemplateId }, select: { id: true, srNo: true, sequence: true } });
  const grouped = groupQcpBySrNo([...items, ...skipped.map((q) => ({ id: null, srNo: q.srNo, sequence: q.sequence }))]);

  const occByVersion = new Map<number, Map<number, number>>();
  for (const versionId of new Set(steps.map((st) => st.templateStep.versionId))) {
    const full = await tx.assemblyTemplateStep.findMany({
      where: { versionId },
      select: { id: true, kind: true, srNo: true },
      orderBy: [{ seq: "asc" }, { id: "asc" }],
    });
    occByVersion.set(versionId, srNoOccurrences(full));
  }

  const idsByItem = new Map<number, number[]>();
  const leftUnbound: BindExistingResult["leftUnbound"] = [];
  for (const st of steps) {
    if (st.status !== "NOT_STARTED") {
      leftUnbound.push({ assemblyStepId: st.id, srNo: st.templateStep.srNo, status: st.status });
      continue;
    }
    const occ = occByVersion.get(st.templateStep.versionId)!;
    const m = matchInspectionStep({ id: st.templateStepId, kind: "INSPECTION", srNo: st.templateStep.srNo }, occ, grouped);
    if (m === "MISSING") {
      throw new AppError(ERROR_CODES.QCP_ITEM_UNRESOLVED, {
        templateStepId: st.templateStepId,
        srNo: st.templateStep.srNo,
        occurrence: occ.get(st.templateStepId) ?? 0,
        qcpTemplateId,
      });
    }
    if (m?.id != null) idsByItem.set(m.id, [...(idsByItem.get(m.id) ?? []), st.id]);
  }
  let bound = 0;
  for (const [qcpItemId, ids] of idsByItem) {
    // The status/qcpItemId guard keeps a step that started meanwhile untouched.
    const r = await tx.assemblyStep.updateMany({ where: { id: { in: ids }, status: "NOT_STARTED", qcpItemId: null }, data: { qcpItemId } });
    bound += r.count;
  }
  return { bound, leftUnbound };
}
