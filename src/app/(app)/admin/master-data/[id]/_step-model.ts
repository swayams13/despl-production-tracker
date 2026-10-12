import type { MasterStepInput } from "@/lib/shared/schemas";
import type { Finding, StepField } from "@/lib/services/master-data.readiness";

/**
 * Pure model behind the step editor: form rows <-> `saveRouteDraft` input,
 * client-side checks, reordering. No React, so it is table-testable.
 * The client checks mirror what the service refuses outright; completeness gaps
 * (a missing department or stage) are NOT refused here: a draft may be saved
 * incomplete and only approval is blocked (the service owns that rule).
 */
export interface EditorRow {
  key: string;
  seq: string;
  operationCode: string;
  department: string;
  pvStage: string;
  heStage: string;
  stdTime: string;
  stdTimeUnit: "" | "HOURS" | "DAYS";
  stdTimeBasis: string;
  conditional: boolean;
  conditionText: string;
  acceptanceStandard: string;
  recordDocument: string;
  whatIsDone: string;
}

export interface SourceStep {
  seq: number;
  operationCode: string;
  department: string;
  pvStage: number | null;
  heStage: number | null;
  stdTime: number | null;
  stdTimeUnit: string | null;
  stdTimeBasis: string | null;
  conditional: boolean;
  conditionText: string;
  acceptanceStandard: string;
  recordDocument: string;
  whatIsDone: string;
}

let keySeq = 0;
const nextKey = () => `r${++keySeq}`;

export function rowsFromSteps(steps: readonly SourceStep[]): EditorRow[] {
  return steps.map((s) => ({
    key: nextKey(),
    seq: String(s.seq),
    operationCode: s.operationCode,
    department: s.department,
    pvStage: s.pvStage == null ? "" : String(s.pvStage),
    heStage: s.heStage == null ? "" : String(s.heStage),
    stdTime: s.stdTime == null ? "" : String(s.stdTime),
    stdTimeUnit: (s.stdTimeUnit ?? "") as EditorRow["stdTimeUnit"],
    stdTimeBasis: s.stdTimeBasis ?? "",
    conditional: s.conditional,
    conditionText: s.conditionText,
    acceptanceStandard: s.acceptanceStandard,
    recordDocument: s.recordDocument,
    whatIsDone: s.whatIsDone,
  }));
}

export function nextSeq(rows: readonly EditorRow[]): number {
  const max = rows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
  return max === 0 ? 10 : Math.floor(max / 10) * 10 + 10;
}

export function newRow(rows: readonly EditorRow[], seed: Partial<EditorRow> = {}): EditorRow {
  return {
    key: nextKey(),
    seq: String(nextSeq(rows)),
    operationCode: "",
    department: "",
    pvStage: "",
    heStage: "",
    stdTime: "",
    stdTimeUnit: "",
    stdTimeBasis: "",
    conditional: false,
    conditionText: "",
    acceptanceStandard: "",
    recordDocument: "",
    whatIsDone: "",
    ...seed,
  };
}

const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));

/** Rows -> the service input, blanks as null, sorted by step number. */
export function toInput(rows: readonly EditorRow[]): MasterStepInput[] {
  return [...rows]
    .map((r) => ({
      seq: Number(r.seq),
      operationCode: r.operationCode.trim(),
      department: r.department.trim(),
      pvStage: num(r.pvStage),
      heStage: num(r.heStage),
      stdTime: num(r.stdTime),
      stdTimeUnit: r.stdTimeUnit === "" ? null : r.stdTimeUnit,
      stdTimeBasis: r.stdTimeBasis === "" ? null : (r.stdTimeBasis as MasterStepInput["stdTimeBasis"]),
      conditional: r.conditional,
      conditionText: r.conditionText.trim(),
      acceptanceStandard: r.acceptanceStandard.trim(),
      recordDocument: r.recordDocument.trim(),
      whatIsDone: r.whatIsDone.trim(),
      requiresQc: true,
    }))
    .sort((a, b) => a.seq - b.seq);
}

export interface RowProblem {
  key: string;
  field: StepField | "seq" | "stdTimeUnit" | "stdTimeBasis";
  message: string;
}

/** What the service would refuse outright, found before the round trip. */
export function validateRows(rows: readonly EditorRow[]): RowProblem[] {
  const out: RowProblem[] = [];
  const seen = new Map<number, string>();
  for (const r of rows) {
    const seq = Number(r.seq);
    if (!Number.isInteger(seq) || seq <= 0) out.push({ key: r.key, field: "seq", message: "Step number must be a whole number above zero." });
    else if (seen.has(seq)) out.push({ key: r.key, field: "seq", message: `Step ${seq} is used twice.` });
    else seen.set(seq, r.key);

    if (r.operationCode.trim() === "") out.push({ key: r.key, field: "operation", message: "Pick an operation." });

    for (const [value, field, label] of [
      [r.pvStage, "pvStage", "PV stage"],
      [r.heStage, "heStage", "HE stage"],
    ] as const) {
      if (value.trim() !== "" && !(Number.isInteger(Number(value)) && Number(value) > 0)) {
        out.push({ key: r.key, field, message: `${label} must be a whole number.` });
      }
    }

    if (r.stdTime.trim() !== "") {
      const t = Number(r.stdTime);
      if (!Number.isFinite(t) || t < 0 || t > 99999.999) out.push({ key: r.key, field: "stdTime", message: "Time must be a number from 0 to 99999.999." });
      if (r.stdTimeUnit === "") out.push({ key: r.key, field: "stdTimeUnit", message: "A time needs a unit." });
      if (r.stdTimeBasis === "") out.push({ key: r.key, field: "stdTimeBasis", message: "A time needs a basis." });
    }
  }
  return out;
}

export function moveRow(rows: readonly EditorRow[], index: number, delta: -1 | 1): EditorRow[] {
  const to = index + delta;
  if (index < 0 || to < 0 || index >= rows.length || to >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** Step numbers 10, 20, 30… in the current row order. */
export function renumberBy10(rows: readonly EditorRow[]): EditorRow[] {
  return rows.map((r, i) => ({ ...r, seq: String((i + 1) * 10) }));
}

export function isDirty(a: readonly EditorRow[], b: readonly EditorRow[]): boolean {
  return JSON.stringify(toInput(a)) !== JSON.stringify(toInput(b));
}

/** Server findings -> messages by row and cell. Findings are keyed by step number. */
export function problemsFromFindings(rows: readonly EditorRow[], findings: readonly Finding[]): RowProblem[] {
  const keyBySeq = new Map(rows.map((r) => [Number(r.seq), r.key]));
  const out: RowProblem[] = [];
  for (const f of findings) {
    if (f.seq == null) continue;
    const key = keyBySeq.get(f.seq);
    if (!key) continue;
    for (const field of f.fields.length > 0 ? f.fields : (["operation"] as StepField[])) {
      out.push({ key, field, message: f.message });
    }
  }
  return out;
}
