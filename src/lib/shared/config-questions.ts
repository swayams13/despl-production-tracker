// Lean Core J2: configuration questions as data (table config_questions), the
// replacement for the hard-coded SPEC_FIELDS (ADR B11 retired). Pure helpers
// shared by createJob, the wizard and the admin screens.
import { ANSWER_KEY_RE, type Scalar } from "./include-when";

export type QuestionType = "NUMBER" | "TEXT" | "SELECT" | "BOOLEAN";

export interface ConfigQuestionDef {
  key: string;
  label: string;
  type: QuestionType;
  unit?: string | null;
  options?: string[] | null;
  default?: Scalar | null;
  help?: string | null;
  /** null = a family-level question; set = asked only for lines of that equipment type. */
  equipmentTypeId?: number | null;
  familyId?: number;
}

export function isValidQuestionKey(key: string): boolean {
  return ANSWER_KEY_RE.test(key);
}

/** Family-level questions plus the ones scoped to this line's equipment type. */
export function questionsForLine(all: ConfigQuestionDef[], equipmentTypeId: number | null): ConfigQuestionDef[] {
  return all.filter((q) => q.equipmentTypeId == null || q.equipmentTypeId === equipmentTypeId);
}

function coerce(q: ConfigQuestionDef, raw: unknown): Scalar | undefined {
  if (raw == null) return undefined;
  if (q.type === "NUMBER") {
    if (typeof raw === "string" && raw.trim() === "") return undefined;
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isFinite(n) ? n : undefined;
  }
  if (q.type === "BOOLEAN") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    return s === "true" || s === "yes" ? true : s === "false" || s === "no" ? false : undefined;
  }
  const s = String(raw).trim();
  if (s === "") return undefined;
  if (q.type === "SELECT" && !(q.options ?? []).includes(s)) return undefined;
  return s;
}

/**
 * Keep only keys with a question, coerced to the declared type. Anything
 * unrecognised or uncoercible is DROPPED rather than stored (a jsonb column
 * takes anything; this is the only thing between a form typo and junk in the record).
 */
export function validateAnswers(
  questions: ConfigQuestionDef[],
  raw: Record<string, unknown> | null | undefined,
): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const q of questions) {
    const v = coerce(q, raw?.[q.key]);
    if (v !== undefined) out[q.key] = v;
  }
  return out;
}

/** Answers with question defaults filled in for unanswered keys; `defaulted` names those keys. */
export function resolveAnswers(
  questions: ConfigQuestionDef[],
  answers: Record<string, Scalar>,
): { resolved: Record<string, Scalar>; defaulted: string[] } {
  const resolved: Record<string, Scalar> = { ...answers };
  const defaulted: string[] = [];
  for (const q of questions) {
    if (resolved[q.key] !== undefined || q.default == null) continue;
    resolved[q.key] = q.default;
    defaulted.push(q.key);
  }
  return { resolved, defaulted };
}
