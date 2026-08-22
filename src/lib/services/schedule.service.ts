import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import {
  requireRole,
  assertNotClientUser,
  assertClientScope,
  ROLES,
} from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { computeEnvelope, checkFeasibility, subtractWorkingDays } from "@/lib/schedule";
import {
  generateScheduleSchema,
  type GenerateScheduleInput,
} from "@/lib/shared/schemas";
import {
  loadJobSpine,
  persistScheduleRun,
  getCurrentScheduleRun,
  type PlanInput,
  type ScheduleRunWithPlans,
} from "./_shared";

/**
 * Schedule generation + read, sitting on the pure lib/schedule engine and the
 * transactional primitives in _shared.ts.
 *
 * First-generation planning is a Layer-1 act: computeEnvelope (the printed,
 * authoritative envelope — invariant #10) drives planned dates, and on a fresh
 * run baseline == planned. CPM/replanning (Layer 2) is not needed here — it
 * comes into play when an actual slips or a duration override lands (a separate
 * service path). Mode only decides how the project-start anchor is derived:
 * FORWARD anchors on the order date, BACKWARD back-counts from the required
 * delivery date so the terminal process's finish lands on it.
 */

/**
 * Generate (and persist as the next version) a FORWARD or BACKWARD schedule for
 * a job/equipment. Planning is a Production-Head/Admin act, not floor work.
 *
 * The engine's computeEnvelope refuses a provisional or duration-less spine
 * with SCHEDULE_DATA_MISSING — we let that surface rather than guessing dates.
 */
export async function generateSchedule(
  actor: Actor,
  input: GenerateScheduleInput,
): Promise<ScheduleRunWithPlans> {
  const parsed = generateScheduleSchema.parse(input);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  assertNotClientUser(actor);

  return withTenant(actor.tenantId, async (tx) => {
    const spine = await loadJobSpine(tx, parsed.jobId);
    assertClientScope(actor, spine.job.clientId);

    const included = spine.processes.filter((p) => p.included !== false);
    if (included.length === 0) {
      throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
        jobId: parsed.jobId,
        reason: "no included processes to schedule",
      });
    }

    // Terminal = latest process by standard (max) envelope finish-by. Its
    // envelope offsets anchor BACKWARD scheduling and feed feasibility. A null
    // here means the terminal is provisional → unschedulable (computeEnvelope
    // would refuse anyway; we refuse with the same code up front).
    const terminal = included.reduce((a, b) =>
      (b.envelopeFinishByMaxDays ?? -Infinity) > (a.envelopeFinishByMaxDays ?? -Infinity) ? b : a,
    );
    if (terminal.envelopeFinishByMaxDays == null || terminal.envelopeFinishByMinDays == null) {
      throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
        processId: terminal.id,
        code: terminal.code,
      });
    }

    // Planning dates a planner legitimately supplies at tender stage are NOT
    // actuals (invariant #1) — the request schema is .strict(); these fall back
    // to the job's own order/delivery dates.
    const orderDate = parsed.projectStartDate ?? spine.job.orderDate;
    const deliveryDate = parsed.requiredDeliveryDate ?? spine.job.committedDeliveryDate;

    // Project-start anchor per mode.
    let projectStart: Date;
    if (parsed.mode === "BACKWARD") {
      if (!deliveryDate) {
        throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
          jobId: parsed.jobId,
          reason: "BACKWARD schedule needs a required delivery date",
        });
      }
      projectStart = subtractWorkingDays(deliveryDate, terminal.envelopeFinishByMaxDays, spine.calendar);
    } else {
      if (!orderDate) {
        throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
          jobId: parsed.jobId,
          reason: "FORWARD schedule needs an order/project-start date",
        });
      }
      projectStart = orderDate;
    }

    // Layer 1 — authoritative planned dates. Throws SCHEDULE_DATA_MISSING for
    // any provisional/duration-less included process (let it surface).
    const envelope = computeEnvelope(spine.processes, projectStart, spine.calendar);

    // Feasibility is a tender-stage check: only meaningful when we know both the
    // order window's ends. Missing either → leave feasibility unstamped.
    const feas =
      orderDate && deliveryDate
        ? checkFeasibility(
            orderDate,
            deliveryDate,
            terminal.envelopeFinishByMinDays,
            terminal.envelopeFinishByMaxDays,
            spine.calendar,
          )
        : null;

    // ponytail: planned = the standard (max) envelope — the committed deadline a
    // department is held to, matching CPM's MAX-duration basis. For the PV v1
    // pilot min==max so it is moot; if a family ever ships a real min/max spread
    // and DESPL wants the optimistic edge planned instead, switch to *Min here.
    const deptByProc = new Map(spine.rawProcesses.map((p) => [p.id, p.departmentId]));

    // Per-unit grain: one plan per (included process × unit). A job with no units
    // (e.g. provisional piping jobs) falls back to a single unitId-null plan/process.
    // ponytail: all units share the equipment envelope dates in v1 — per-serial
    // stagger is a Phase-2 sequencing concern, not modelled here.
    const units = await tx.unit.findMany({
      where: {
        equipment:
          parsed.equipmentId != null
            ? { id: parsed.equipmentId, jobId: parsed.jobId }
            : { jobId: parsed.jobId },
      },
      select: { id: true },
    });
    const unitIds: (number | null)[] = units.length > 0 ? units.map((u) => u.id) : [null];

    const plans: PlanInput[] = unitIds.flatMap((unitId) =>
      envelope.map((e) => ({
        jobProcessId: e.processId,
        ownerDepartmentId: deptByProc.get(e.processId)!,
        unitId,
        baselineStart: e.plannedStartMax,
        baselineFinish: e.plannedFinishMax,
        plannedStart: e.plannedStartMax,
        plannedFinish: e.plannedFinishMax,
      })),
    );

    return persistScheduleRun(tx, actor, {
      jobId: parsed.jobId,
      equipmentId: parsed.equipmentId ?? null,
      mode: parsed.mode,
      projectStartDate: projectStart,
      requiredDeliveryDate: deliveryDate ?? null,
      feasibility: feas?.feasibility ?? null,
      shortfallDays: feas?.shortfallDays ?? null,
      overrideReason: null,
      plans,
    });
  });
}

/**
 * The current schedule run (with plans) for a job/equipment, or null. Read-only:
 * any actor who can see the job's client may read it (client viewers included).
 */
export async function getSchedule(
  actor: Actor,
  jobId: number,
  equipmentId?: number | null,
): Promise<ScheduleRunWithPlans | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });
    assertClientScope(actor, job.clientId);
    return getCurrentScheduleRun(tx, jobId, equipmentId ?? null);
  });
}
