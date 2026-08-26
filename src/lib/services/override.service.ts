import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { requireRole, assertNotClientUser, ROLES } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { applyOverride, addWorkingDays } from "@/lib/schedule";
import { applyDurationOverrideSchema } from "@/lib/shared/schemas";
import type { ApplyDurationOverrideInput } from "@/lib/shared/schemas";
import {
  loadJobSpine,
  getCurrentScheduleRun,
  persistScheduleRun,
  computeOrRefuse,
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
 *   2. FIXES the Layer-1↔Layer-2 desync: restamps this job's MAX envelope
 *      offsets (Layer 1) from the recomputed CPM so the authoritative window and
 *      the plan agree, instead of leaving the printed offsets stale (the flagged
 *      medium bug — see the restamp block). MIN offsets are deliberately left
 *      untouched (audit C2 — see the restamp block for why);
 *   3. persists a NEW ScheduleRun version (mode OVERRIDE) whose planned dates
 *      are the recomputed plan and whose baseline carries the prior run's
 *      baseline forward — the old baseline is never mutated (invariant #6);
 *   4. audits the JobProcess change; persistScheduleRun audits the new run.
 * All in one transaction.
 */

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
    // Refuse on jobs with units (audit H7): this override writes unitId:null
    // plans, which would become isCurrent and supersede the per-unit run —
    // every per-unit plan then has a stale scheduleRunId, predecessor lookup
    // finds nothing, and gating fails closed everywhere, silently, for the
    // whole job. Override has no per-unit UI caller in this prototype; block
    // rather than risk a job-level write against a job schedule the unit runs
    // no longer read.
    const unitCount = await tx.unit.count({ where: { equipment: { jobId } } });
    if (unitCount > 0) {
      throw new AppError(ERROR_CODES.OVERRIDE_NOT_SUPPORTED_WITH_UNITS, { jobId, unitCount });
    }

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
    const maxByPid = new Map(maxNodes.map((n) => [n.processId, n]));

    // ── Fix the Layer-1↔Layer-2 desync (flagged medium bug) ────────────────
    // Once a duration override exists the printed MAX envelope offsets are
    // stale; restamp them from the recomputed CPM so computeEnvelope (Layer 1)
    // and the CPM plan (Layer 2) agree on MAX. Unchanged processes get
    // identical MAX offsets (CPM-max reproduces the printed finishByMax exactly
    // — cpm.ts); the overridden process and everything downstream shift.
    //
    // MIN offsets are intentionally left untouched (audit C2). A min-space CPM
    // pass here would use the SAME lags the schedule was fitted against for
    // MAX durations only — in min space those lags corrupt the terminal node
    // (P36 collapses to ~36 days instead of the real ~119), so every job with
    // one override reads requiredMinDays ≈ 36 forever after and checkFeasibility
    // can never again return INFEASIBLE. The printed min envelope from job
    // intake is the authoritative Layer-1 figure (BUILD-SPEC-v2 §1's two-layer
    // model); recomputing it from CPM is not more correct, just differently wrong.
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
      if (!mx) continue; // excluded — spliced out of the CPM, offsets unused
      const after = {
        envelopeStartByMaxDays: mx.earlyStart,
        envelopeFinishByMaxDays: mx.earlyFinish,
      };
      restamped.push({
        processId: p.id,
        before: {
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
    const requiredDeliveryDate = priorRun?.requiredDeliveryDate ?? spine.job.committedDeliveryDate ?? null;
    const deptByPid = new Map(spine.rawProcesses.map((p) => [p.id, p.departmentId]));

    const plans: PlanInput[] = maxNodes.map((n) => {
      const plannedStart = addWorkingDays(projectStartDate, n.earlyStart, spine.calendar);
      const plannedFinish = addWorkingDays(projectStartDate, n.earlyFinish, spine.calendar);
      const carried = priorBaseline.get(n.processId);
      return {
        jobProcessId: n.processId,
        ownerDepartmentId: deptByPid.get(n.processId)!,
        // ponytail: override stays job/equipment grain (unitId null) for now — it
        // has no UI caller in this prototype. Must expand per-unit (like
        // generateSchedule) before override is wired to a screen, or it would
        // demote the per-unit run and mix grains.
        unitId: null,
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
