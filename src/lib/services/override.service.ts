import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { requireRole, assertNotClientUser, ROLES } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES, isAppError } from "@/lib/shared/errors";
import { applyOverride, computeCpm, addWorkingDays } from "@/lib/schedule";
import { applyDurationOverrideSchema } from "@/lib/shared/schemas";
import type { ApplyDurationOverrideInput } from "@/lib/shared/schemas";
import {
  loadJobSpine,
  getCurrentScheduleRun,
  persistScheduleRun,
  type PlanInput,
  type ScheduleRunWithPlans,
} from "./_shared";

/**
 * Planner duration override (BUILD-SPEC-v2 §1.4, CLAUDE.md invariants #6/#12).
 *
 * A Production Head / Admin pins one process's duration to a new value with a
 * mandatory reason. This:
 *   1. recomputes the CPM plan (Layer 2) from the override — reason enforced by
 *      the pure engine (applyOverride);
 *   2. FIXES the Layer-1↔Layer-2 desync: restamps this job's envelope offsets
 *      (Layer 1) from the recomputed CPM so the authoritative window and the
 *      plan agree, instead of leaving the printed offsets stale (the flagged
 *      medium bug — see the restamp block);
 *   3. persists a NEW ScheduleRun version (mode OVERRIDE) whose planned dates
 *      are the recomputed plan and whose baseline carries the prior run's
 *      baseline forward — the old baseline is never mutated (invariant #6);
 *   4. audits the JobProcess change; persistScheduleRun audits the new run.
 * All in one transaction.
 */

/** Bare Errors from the CPM (cycle, dangling edge) become an explainable
 *  refusal (invariant #12); AppErrors (e.g. SCHEDULE_DATA_MISSING) pass through. */
function computeOrRefuse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (isAppError(e)) throw e;
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function applyDurationOverride(
  actor: Actor,
  input: ApplyDurationOverrideInput,
): Promise<ScheduleRunWithPlans> {
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  assertNotClientUser(actor);

  const equipmentId = input.equipmentId ?? null;

  // Reason gate up front so a reasonless override refuses with the stable
  // OVERRIDE_REASON_REQUIRED code (invariant #6/#12) rather than the generic
  // parse error, before any tx opens — unit-testable without a DB. applyOverride
  // re-enforces it (defence in depth).
  // ponytail: this guard owns the reason error code; parse below owns the rest.
  if (!input.reason || input.reason.trim().length === 0) {
    throw new AppError(ERROR_CODES.OVERRIDE_REASON_REQUIRED);
  }

  // Schema is the single validation source (invariant #1): positive-int duration
  // and .strict() unknown-key defense the hand-rolled guard skipped. Runs before
  // withTenant so it stays no-DB / unit-testable, like the other services.
  const { jobId, jobProcessId, durationOverrideDays, reason } =
    applyDurationOverrideSchema.parse(input);

  return withTenant(actor.tenantId, async (tx) => {
    const spine = await loadJobSpine(tx, jobId); // throws NOT_FOUND
    const target = spine.rawProcesses.find((p) => p.id === jobProcessId);
    if (!target) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "JobProcess", jobProcessId });
    }

    // Layer 2 — recomputed CPM on MAX durations with the new override applied.
    // Prior overrides are already baked into the mapped durations by
    // jobProcessToScheduleProcess, so priorOverrides stays empty (no double-apply).
    const overridePlan = computeOrRefuse(() =>
      applyOverride(spine.processes, spine.edges, {
        processId: jobProcessId,
        durationOverrideDays,
        reason,
      }),
    );
    const maxNodes = overridePlan.current;

    // MIN-space pass: each process's min duration, with the new override
    // collapsing the overridden process (min == max == override).
    const minMap = new Map<number, number>();
    for (const p of spine.processes) if (p.durationMinDays != null) minMap.set(p.id, p.durationMinDays);
    minMap.set(jobProcessId, durationOverrideDays);
    const minNodes = computeOrRefuse(() =>
      computeCpm(spine.processes, spine.edges, { durationDaysByProcessId: minMap }),
    );

    const maxByPid = new Map(maxNodes.map((n) => [n.processId, n]));
    const minByPid = new Map(minNodes.map((n) => [n.processId, n]));

    // ── Fix the Layer-1↔Layer-2 desync (flagged medium bug) ────────────────
    // Once a duration override exists the printed envelope offsets are stale;
    // restamp them from the recomputed CPM so computeEnvelope (Layer 1) and the
    // CPM plan (Layer 2) produce the same dates. Unchanged processes get
    // identical MAX offsets (CPM-max reproduces the printed finishByMax exactly
    // — cpm.ts), the overridden process and everything downstream shift. MIN
    // offsets are recomputed too, so the window stays coherent (min ≤ max) even
    // when the override SHORTENS a duration — leaving the printed min untouched
    // could make finishByMin > finishByMax. This makes CPM the source of truth
    // for this job's envelope past the first override: the intended two-layer
    // replanning semantics (BUILD-SPEC-v2 §1), a strictly smaller change than
    // nulling the offsets (which would make Layer 1 refuse, not agree).
    // Every restamped row overwrites authoritative Layer-1 offsets in place, so
    // capture its before/after for the audit payload (invariant #5/#6) — not just
    // the target's. One audit row (below) carries the whole {processId,before,after}
    // list, so the prior printed envelope of downstream processes stays recoverable.
    const restamped: Array<{
      processId: number;
      before: Record<string, number | null>;
      after: Record<string, number | null>;
    }> = [];
    for (const p of spine.rawProcesses) {
      const mx = maxByPid.get(p.id);
      const mn = minByPid.get(p.id);
      if (!mx || !mn) continue; // excluded — spliced out of the CPM, offsets unused
      const after = {
        envelopeStartByMinDays: mn.earlyStart,
        envelopeFinishByMinDays: mn.earlyFinish,
        envelopeStartByMaxDays: mx.earlyStart,
        envelopeFinishByMaxDays: mx.earlyFinish,
      };
      restamped.push({
        processId: p.id,
        before: {
          envelopeStartByMinDays: p.envelopeStartByMinDays,
          envelopeFinishByMinDays: p.envelopeFinishByMinDays,
          envelopeStartByMaxDays: p.envelopeStartByMaxDays,
          envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
        },
        after,
      });
      await tx.jobProcess.update({
        where: { id: p.id },
        data: {
          ...after,
          ...(p.id === jobProcessId ? { durationOverrideDays, overrideReason: reason } : {}),
        },
      });
    }

    // Prior run: carry its baseline forward, never mutate it (invariant #6).
    const priorRun = await getCurrentScheduleRun(tx, jobId, equipmentId);
    const priorBaseline = new Map(
      (priorRun?.processPlans ?? []).map((pp) => [
        pp.jobProcessId,
        { baselineStart: pp.baselineStart, baselineFinish: pp.baselineFinish },
      ]),
    );

    const projectStartDate = priorRun?.projectStartDate ?? spine.job.orderDate ?? new Date();
    const requiredDeliveryDate = priorRun?.requiredDeliveryDate ?? spine.job.deliveryDate ?? null;
    const deptByPid = new Map(spine.rawProcesses.map((p) => [p.id, p.departmentId]));

    const plans: PlanInput[] = maxNodes.map((n) => {
      const plannedStart = addWorkingDays(projectStartDate, n.earlyStart, spine.calendar);
      const plannedFinish = addWorkingDays(projectStartDate, n.earlyFinish, spine.calendar);
      const carried = priorBaseline.get(n.processId);
      return {
        jobProcessId: n.processId,
        ownerDepartmentId: deptByPid.get(n.processId)!,
        // Baseline := the prior run's baseline (preserved). A process with no
        // prior plan seeds its baseline from its own recomputed planned dates.
        baselineStart: carried?.baselineStart ?? plannedStart,
        baselineFinish: carried?.baselineFinish ?? plannedFinish,
        plannedStart,
        plannedFinish,
      };
    });

    await recordAudit(tx, actor, {
      action: "schedule.override",
      entityType: "JobProcess",
      entityId: jobProcessId,
      before: {
        durationOverrideDays: target.durationOverrideDays,
        overrideReason: target.overrideReason,
        envelopeStartByMaxDays: target.envelopeStartByMaxDays,
        envelopeFinishByMaxDays: target.envelopeFinishByMaxDays,
      },
      after: {
        durationOverrideDays,
        overrideReason: reason,
        envelopeStartByMaxDays: maxByPid.get(jobProcessId)?.earlyStart ?? null,
        envelopeFinishByMaxDays: maxByPid.get(jobProcessId)?.earlyFinish ?? null,
        restampedProcessCount: restamped.length,
        // before/after of every restamped downstream row — Layer-1 recoverable.
        restamped,
      },
      eventType: "DurationOverridden",
      eventPayload: { jobId, equipmentId, jobProcessId, durationOverrideDays },
    });

    return persistScheduleRun(tx, actor, {
      jobId,
      equipmentId,
      mode: "OVERRIDE",
      projectStartDate,
      requiredDeliveryDate,
      feasibility: priorRun?.feasibility ?? null,
      shortfallDays: priorRun?.shortfallDays ?? null,
      overrideReason: reason,
      plans,
    });
  });
}
