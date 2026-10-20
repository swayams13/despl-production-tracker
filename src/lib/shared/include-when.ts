// Lean Core J2: the "includeWhen" rule on TemplateProcess, RouteStep,
// AssemblyTemplateStep and QcpItem. Data, never code: {all|any: [{key, op, value}]}
// with op eq | neq | in | truthy. Evaluated ONCE at configure time (createJob,
// BOM release); the result is written to the job's materialised rows and the
// config_rule_decisions ledger. Scheduling and gating never import this file.
import { z } from "zod";

export const ANSWER_KEY_RE = /^[a-z][a-z0-9_]*$/;

const scalar = z.union([z.string(), z.number(), z.boolean()]);
export type Scalar = z.infer<typeof scalar>;

const clauseSchema = z
  .object({
    key: z.string().regex(ANSWER_KEY_RE),
    op: z.enum(["eq", "neq", "in", "truthy"]),
    value: z.union([scalar, z.array(scalar).min(1)]).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ok =
      c.op === "truthy"
        ? c.value === undefined
        : c.op === "in"
          ? Array.isArray(c.value)
          : c.value !== undefined && !Array.isArray(c.value);
    if (!ok) ctx.addIssue({ code: "custom", message: `op "${c.op}" has the wrong value shape` });
  });

export const includeWhenSchema = z.union([
  z.object({ all: z.array(clauseSchema).min(1) }).strict(),
  z.object({ any: z.array(clauseSchema).min(1) }).strict(),
]);
export type IncludeWhen = z.infer<typeof includeWhenSchema>;
type Clause = z.infer<typeof clauseSchema>;

export interface ClauseResult {
  key: string;
  op: Clause["op"];
  value?: Clause["value"];
  /** The answer used; undefined when the key was not answered and has no default. */
  answer?: Scalar;
  /** null = the key had no answer. */
  result: boolean | null;
}

export interface RuleDecision {
  included: boolean;
  /** True when the outcome rests on a missing answer or an unreadable rule: the planner should look. */
  flagged: boolean;
  reason: {
    rule: unknown;
    clauses: ClauseResult[];
    missing: string[];
    invalid?: string;
  };
}

const FALSY_WORDS = new Set(["", "false", "no", "0", "none"]);

function isTruthy(a: Scalar): boolean {
  if (typeof a === "boolean") return a;
  if (typeof a === "number") return a !== 0;
  return !FALSY_WORDS.has(a.trim().toLowerCase());
}

/** Same type: strict. Mixed types ("true" vs true, "12" vs 12): compare as lower-cased text. */
function same(a: Scalar, b: Scalar): boolean {
  return typeof a === typeof b ? a === b : String(a).toLowerCase() === String(b).toLowerCase();
}

function runClause(c: Clause, answers: Record<string, unknown>): ClauseResult {
  const raw = answers[c.key];
  const answer = typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? raw : undefined;
  const base = { key: c.key, op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) };
  if (answer === undefined) return { ...base, result: null };
  const result =
    c.op === "truthy"
      ? isTruthy(answer)
      : c.op === "eq"
        ? same(answer, c.value as Scalar)
        : c.op === "neq"
          ? !same(answer, c.value as Scalar)
          : (c.value as Scalar[]).some((v) => same(answer, v));
  return { ...base, answer, result };
}

/**
 * included = the rule says the item applies. Missing answers and unreadable
 * rules never exclude: they include and flag, so a gap shows up for review
 * instead of silently dropping work. No rule at all = included, not flagged.
 */
export function evaluateIncludeWhen(rule: unknown, answers: Record<string, unknown>): RuleDecision {
  if (rule == null) return { included: true, flagged: false, reason: { rule: null, clauses: [], missing: [] } };
  const parsed = includeWhenSchema.safeParse(rule);
  if (!parsed.success) {
    return {
      included: true,
      flagged: true,
      reason: { rule, clauses: [], missing: [], invalid: parsed.error.issues[0]?.message ?? "unreadable rule" },
    };
  }
  const data = parsed.data;
  const isAll = "all" in data;
  const clauses = ("all" in data ? data.all : data.any).map((c) => runClause(c, answers));
  const missing = clauses.filter((c) => c.result === null).map((c) => c.key);
  const anyFalse = clauses.some((c) => c.result === false);
  const anyTrue = clauses.some((c) => c.result === true);
  const included = isAll ? !anyFalse : anyTrue || missing.length > 0;
  // flagged only when a missing answer decided the outcome
  const flagged = missing.length > 0 && (isAll ? !anyFalse : !anyTrue);
  return { included, flagged, reason: { rule: parsed.data, clauses, missing } };
}
