// Lean Core J2: configure-time evaluation of includeWhen rules for one
// equipment line, and the append-only ledger of what each rule decided.
// Relative imports only (like equipment-type.setup.ts): scripts use it too.
// Nothing in scheduling or gating imports this file; they read materialised rows.
import type { Prisma } from "../../generated/prisma/client";
import {
  questionsForLine,
  resolveAnswers,
  validateAnswers,
  type ConfigQuestionDef,
} from "../shared/config-questions";
import { evaluateIncludeWhen, type RuleDecision, type Scalar } from "../shared/include-when";

type Db = Prisma.TransactionClient;
export type RuleEntity = "TEMPLATE_PROCESS" | "ASSEMBLY_STEP" | "ROUTE_STEP" | "QCP_ITEM";

/** Active questions of one family (family-level and every equipment type's), or of every family when none is given. */
export async function loadQuestionDefs(db: Db, tenantId: number, familyId?: number): Promise<ConfigQuestionDef[]> {
  const rows = await db.configQuestion.findMany({
    where: { tenantId, ...(familyId !== undefined ? { familyId } : {}), active: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    type: r.type,
    unit: r.unit,
    options: Array.isArray(r.options) ? (r.options as string[]) : null,
    default: (r.defaultValue as Scalar | null) ?? null,
    help: r.help,
    equipmentTypeId: r.equipmentTypeId,
    familyId: r.familyId,
  }));
}

/** The answers worth storing on the line: only keys with a question, coerced. */
export function lineConfig(
  all: ConfigQuestionDef[],
  equipmentTypeId: number | null,
  raw: Record<string, unknown> | null | undefined,
): Record<string, Scalar> {
  return validateAnswers(questionsForLine(all, equipmentTypeId), raw);
}

export class LineRules {
  readonly rows: Prisma.ConfigRuleDecisionCreateManyInput[] = [];
  private readonly seen = new Map<string, boolean>();

  constructor(
    readonly jobId: number,
    readonly equipmentId: number,
    private readonly resolved: Record<string, Scalar>,
    private readonly defaulted: string[],
  ) {}

  static fromConfig(
    jobId: number,
    equipmentId: number,
    all: ConfigQuestionDef[],
    equipmentTypeId: number | null,
    config: Record<string, Scalar>,
  ): LineRules {
    const { resolved, defaulted } = resolveAnswers(questionsForLine(all, equipmentTypeId), config);
    return new LineRules(jobId, equipmentId, resolved, defaulted);
  }

  static async load(db: Db, equipmentId: number): Promise<LineRules> {
    const eq = await db.equipment.findUniqueOrThrow({
      where: { id: equipmentId },
      select: { jobId: true, equipmentTypeId: true, config: true, job: { select: { tenantId: true, familyId: true } } },
    });
    const all = await loadQuestionDefs(db, eq.job.tenantId, eq.job.familyId);
    return LineRules.fromConfig(eq.jobId, equipmentId, all, eq.equipmentTypeId, (eq.config as Record<string, Scalar> | null) ?? {});
  }

  /** Evaluates without recording (used when several lines vote on one job-level item). */
  peek(rule: unknown): RuleDecision {
    const d = evaluateIncludeWhen(rule, this.resolved);
    const used = new Set(d.reason.clauses.map((c) => c.key));
    return {
      ...d,
      reason: { ...d.reason, ...(this.defaulted.some((k) => used.has(k)) ? { defaultedKeys: this.defaulted.filter((k) => used.has(k)) } : {}) },
    } as RuleDecision;
  }

  /** Included or not, and (for an entity that carries a rule) one ledger row per entity. */
  decide(entityType: RuleEntity, entityId: number, rule: unknown): boolean {
    if (rule == null) return true;
    const k = `${entityType}:${entityId}`;
    const hit = this.seen.get(k);
    if (hit !== undefined) return hit;
    const d = this.peek(rule);
    this.record(entityType, entityId, d);
    this.seen.set(k, d.included);
    return d.included;
  }

  record(entityType: RuleEntity, entityId: number, d: RuleDecision): void {
    this.rows.push({
      jobId: this.jobId,
      equipmentId: this.equipmentId,
      entityType,
      entityId,
      included: d.included,
      flagged: d.flagged,
      reason: d.reason as unknown as Prisma.InputJsonValue,
    });
  }
}

/** Writes the ledger rows, skipping any (line, entity) already on record. */
export async function flushRuleDecisions(db: Db, rules: LineRules[]): Promise<{ written: number; flagged: number }> {
  let written = 0;
  let flagged = 0;
  for (const r of rules) {
    if (r.rows.length === 0) continue;
    const have = await db.configRuleDecision.findMany({
      where: { equipmentId: r.equipmentId },
      select: { entityType: true, entityId: true },
    });
    const haveKeys = new Set(have.map((h) => `${h.entityType}:${h.entityId}`));
    const fresh = r.rows.filter((row) => !haveKeys.has(`${row.entityType}:${row.entityId}`));
    if (fresh.length === 0) continue;
    await db.configRuleDecision.createMany({ data: fresh });
    written += fresh.length;
    flagged += fresh.filter((f) => f.flagged).length;
  }
  return { written, flagged };
}
