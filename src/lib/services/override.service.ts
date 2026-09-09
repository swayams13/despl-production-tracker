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
 *   2. persists a NEW ScheduleRun version (mode OVERRIDE) whose planned dates
 *      are the recomputed plan and whose baseline carries the prior run's
 *      baseline forward — the old baseline is never mutated (invariant #6);
 *   3. audits the override; persistScheduleRun audits the new run.
 * All in one transaction.
 *
 * AUD-035 — the printed envelope (`JobProcess`'s four `envelope*Days`
 * columns) is Layer 1 and invariant #10 makes it authoritative and immutable
 * after intake: it is written once, by intake/`generateSchedule`, never
 * again. An earlier version of this function restamped the MAX offsets from
 * the recomputed CPM on every override "to fix the Layer-1↔Layer-2 desync" —
 * that was itself the AUD-035 bug (a destructive in-place edit to Layer 1),
 * not a fix for one. Nothing reads these columns back for a "current CPM
 * position" question: `generateSchedule`'s `checkFeasibility` call reads them
 * fresh at intake/regeneration time, against the job's originally committed
 * order window — restamping them mid-project doesn't serve that reader, it
 * just corrupts the printed commitment feasibility is supposed to be checked
 * against. Anything that wants the override-adjusted current position reads
 * Layer 2 instead: this run's `ProcessPlan.plannedStart`/`plannedFinish`,
 * computed below from the same CPM recompute. `durationOverrideDays` and
 * `overrideReason` on the target `JobProcess` row are the override's own
 * recorded input, not a derived envelope value, and stay written here.
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

    // Record the override's own input on the target row only (invariant #10 —
    // the four envelope* columns are never written here; see the function
    // comment for why restamping them was itself the AUD-035 bug).
    await tx.jobProcess.update({
      where: { id: jobProcessId },
      data: { durationOverrideDays, overrideReason: reason },
    });

    // Prior run: carry its baseline forward, never mutate it (invariant #6).
    // AUD-034: getCurrentScheduleRun no longer takes equipmentId — one
    // current run per job, full stop, so this is the job's only current run.
    const priorRun = await getCurrentScheduleRun(tx, jobId);
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
      },
      after: {
        durationOverrideDays,
        overrideReason: reason,
        // Layer-2 position resulting from this override — recorded for
        // traceability, not written back to Layer 1 (invariant #10).
        recomputedEarlyStart: maxByPid.get(jobProcessId)?.earlyStart ?? null,
        recomputedEarlyFinish: maxByPid.get(jobProcessId)?.earlyFinish ?? null,
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
