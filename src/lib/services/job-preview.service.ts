import { withTenant } from "@/lib/db";
import { ROLES, requireRole, assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES, isAppError } from "@/lib/shared/errors";
import { createJobSchema, type CreateJobInput } from "@/lib/shared/schemas";
import { checkFeasibility, selectTerminal, type FeasibilityResult } from "@/lib/schedule";
import { createJobTx, type CreateJobResult } from "./job-intake.service";
import { inRoute, routeKey } from "./line-route";
import { loadJobSpine } from "./_shared";
import { ensureDraftRevisionTx } from "./bom.service";
import { runBomRelease, type BomReleaseCounts } from "./bom-release.service";

/**
 * J7a: what createJob would make, without making it.
 *
 * The preview IS createJobTx run inside a transaction that is rolled back with a sentinel error, so
 * the counts, the rule decisions and the refusals are the real ones, not a second implementation
 * that can drift. ponytail: a rolled-back run consumes sequence ids, harmless.
 */

export const JOB_PREVIEW_ROLES = [ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.PLANNER] as const;

export interface JobPreview {
  result: CreateJobResult;
  processes: {
    code: string;
    name: string;
    grain: string;
    /** Equipment name for a line's own row, null for a job-level one. */
    line: string | null;
    included: boolean;
    /** Why a process is out: the planner's own exclusion, or an includeWhen rule. Null when included. */
    excludedBy: "PLANNER" | "RULE" | null;
    /** Per line: the rule's decision and the answers it could not read. */
    ruleLines: { line: number; included: boolean; flagged: boolean; missing: string[]; invalid?: string }[];
  }[];
  ruleDecisions: { entityType: string; included: boolean; flagged: boolean }[];
  /** What releasing each line's (draft) BOM would make. A refusal is shown, never thrown. */
  lines: { name: string; units: number; release: { counts: BomReleaseCounts | null; state: string; warnings: string[]; refusals: string[] } | { error: { code: string; message: string } } }[];
  /** The standard-envelope check of the delivery window; null when dates or durations are missing. */
  feasibility: (FeasibilityResult & { terminalCode: string }) | { dataMissing: string } | null;
}

class Rollback extends Error {
  constructor(readonly preview: JobPreview) {
    super("preview rollback");
  }
}

export async function previewJob(actor: Actor, input: CreateJobInput): Promise<JobPreview> {
  const parsed = createJobSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ...JOB_PREVIEW_ROLES);
  try {
    await withTenant(actor.tenantId, async (tx) => {
      const result = await createJobTx(tx, actor, parsed);
      const jobId = result.jobId;
      const [rows, decisions, equipments, spine] = await Promise.all([
        tx.jobProcess.findMany({ where: { jobId }, orderBy: [{ seq: "asc" }, { id: "asc" }], select: { code: true, name: true, grain: true, equipmentId: true, included: true, inclusionReason: true } }),
        tx.configRuleDecision.findMany({ where: { jobId }, select: { entityType: true, included: true, flagged: true } }),
        tx.equipment.findMany({ where: { jobId }, orderBy: { id: "asc" }, select: { id: true, name: true, templateVersionId: true, units: { select: { id: true } } } }),
        loadJobSpine(tx, jobId),
      ]);
      const nameOf = new Map(equipments.map((e) => [e.id, e.name]));
      const excluded = new Set(parsed.excludedProcessCodes);

      // The floor rows each line's BOM release would make. A line with no BOM gets an empty draft (releasable).
      const lines: JobPreview["lines"] = [];
      for (const e of equipments) {
        try {
          const draft = await ensureDraftRevisionTx(tx, actor, e.id, jobId);
          if (!draft) throw new AppError(ERROR_CODES.BOM_ALREADY_MATERIALIZED, { equipmentId: e.id });
          const p = await runBomRelease(tx, actor, e.id, draft.id);
          lines.push({ name: e.name, units: e.units.length, release: { counts: p.counts, state: p.state, warnings: p.warnings.map((w) => w.message), refusals: p.refusals.map((r) => r.message) } });
        } catch (err) {
          if (!isAppError(err)) throw err;
          lines.push({ name: e.name, units: e.units.length, release: { error: { code: err.code, message: err.message } } });
        }
      }

      // Feasibility as generateSchedule does it: each route's sink process against the delivery window, worst route wins.
      let feasibility: JobPreview["feasibility"] = null;
      const { orderDate, committedDeliveryDate: delivery } = spine.job;
      if (orderDate && delivery) {
        const rank = { FEASIBLE: 0, TIGHT: 1, INFEASIBLE: 2 } as const;
        const keys = new Set(equipments.map((e) => routeKey(spine.job.templateVersionId, e)));
        for (const key of keys) {
          const ids = new Set(spine.rawProcesses.filter((p) => inRoute(p, key)).map((p) => p.id));
          const processes = spine.processes.filter((p) => ids.has(p.id));
          const edges = spine.edges.filter((x) => ids.has(x.processId) && ids.has(x.predecessorId));
          if (!processes.some((p) => p.included !== false)) continue;
          const t = selectTerminal(processes, edges);
          if (t.envelopeFinishByMinDays == null || t.envelopeFinishByMaxDays == null) {
            feasibility ??= { dataMissing: `Process ${t.code} has no confirmed duration yet, so the delivery window cannot be checked.` };
            continue;
          }
          const f = checkFeasibility(orderDate, delivery, t.envelopeFinishByMinDays, t.envelopeFinishByMaxDays, spine.calendar);
          const worse = feasibility == null || "dataMissing" in feasibility || rank[f.feasibility] > rank[feasibility.feasibility];
          if (worse) feasibility = { ...f, terminalCode: String(t.code) };
        }
      }

      throw new Rollback({
        result,
        processes: rows.map((r) => {
          const reason = r.inclusionReason as { byRule?: boolean; lines?: { line: number; included: boolean; flagged?: boolean; missing?: string[]; invalid?: string }[] } | null;
          return {
            code: r.code,
            name: r.name,
            grain: r.grain,
            line: r.equipmentId != null ? nameOf.get(r.equipmentId) ?? null : null,
            included: r.included,
            excludedBy: r.included ? null : excluded.has(r.code) ? "PLANNER" : "RULE",
            ruleLines: (reason?.lines ?? []).map((l) => ({ line: l.line, included: l.included, flagged: !!l.flagged, missing: l.missing ?? [], ...(l.invalid ? { invalid: l.invalid } : {}) })),
          };
        }),
        ruleDecisions: decisions,
        lines,
        feasibility,
      });
    });
  } catch (e) {
    if (e instanceof Rollback) return e.preview;
    throw e;
  }
  throw new Error("unreachable");
}
