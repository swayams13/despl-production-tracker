import type { NormalStep } from "./master-import.rules";

/**
 * "What changed since the published version" — shown to the approver so a
 * revision is read as a change, not re-read as a whole route. Pure.
 */
export type StepChange =
  | { seq: number; kind: "added" }
  | { seq: number; kind: "removed" }
  | { seq: number; kind: "changed"; fields: string[] };

const COMPARED: Array<[keyof NormalStep, string]> = [
  ["operationCode", "operation"],
  ["department", "department"],
  ["pvStage", "PV stage"],
  ["heStage", "HE stage"],
  ["stdTime", "time"],
  ["stdTimeUnit", "time unit"],
  ["stdTimeBasis", "time basis"],
  ["conditional", "conditional"],
  ["conditionText", "condition"],
  ["acceptanceStandard", "acceptance"],
  ["recordDocument", "record"],
  ["whatIsDone", "description"],
  ["requiresQc", "QC"],
];

export function diffSteps(published: readonly NormalStep[], draft: readonly NormalStep[]): StepChange[] {
  const before = new Map(published.map((s) => [s.seq, s]));
  const after = new Map(draft.map((s) => [s.seq, s]));
  const out: StepChange[] = [];
  for (const [seq, d] of after) {
    const p = before.get(seq);
    if (!p) {
      out.push({ seq, kind: "added" });
      continue;
    }
    const fields = COMPARED.filter(([k]) => p[k] !== d[k]).map(([, label]) => label);
    if (fields.length > 0) out.push({ seq, kind: "changed", fields });
  }
  for (const seq of before.keys()) if (!after.has(seq)) out.push({ seq, kind: "removed" });
  return out.sort((a, b) => a.seq - b.seq);
}
