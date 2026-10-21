import { withTenant } from '@/lib/db';
import type { Actor } from '@/lib/authz';
import { requireRole, assertNotClientUser, assertClientScope, ROLES } from '@/lib/authz';
import { AppError, ERROR_CODES } from '@/lib/shared/errors';
import {
  computeEnvelope,
  checkFeasibility,
  subtractWorkingDays,
  selectTerminal,
} from '@/lib/schedule';
import { inRoute, routeKey } from './line-route';
import { generateScheduleSchema, type GenerateScheduleInput } from '@/lib/shared/schemas';
import {
  loadJobSpine,
  persistScheduleRun,
  getCurrentScheduleRun,
  type PlanInput,
  type ScheduleRunWithPlans,
} from './_shared';

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

    // J3a: a line on another route is scheduled on its own subgraph; every line on the
    // job's own route shares the job-level one (a single-route job is one group, as before).
    const equipments = await tx.equipment.findMany({
      where:
        parsed.equipmentId != null
          ? { id: parsed.equipmentId, jobId: parsed.jobId }
          : { jobId: parsed.jobId },
      select: {
        id: true,
        templateVersionId: true,
        units: { select: { id: true }, orderBy: { id: 'asc' } },
      },
      orderBy: { id: 'asc' },
    });
    const groups = new Map<number | null, number[]>();
    for (const eq of equipments) {
      const key = routeKey(spine.job.templateVersionId, eq);
      groups.set(key, [...(groups.get(key) ?? []), ...eq.units.map((u) => u.id)]);
    }
    // A job with no units (e.g. provisional piping jobs) keeps a single unitId-null plan per process.
    const routeEntries = [...groups.entries()].filter(([, unitIds]) => unitIds.length > 0);
    if (routeEntries.length === 0) routeEntries.push([null, []]);

    const included = spine.processes.filter((p) => p.included !== false);
    if (included.length === 0) {
      throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
        jobId: parsed.jobId,
        reason: 'no included processes to schedule',
      });
    }

    // Per route: its processes, edges and terminal. Terminal = the DAG's sink
    // (audit 0.9 — see selectTerminal's own comment for why "latest by max
    // envelope" alone is not enough, and not deterministic without
    // loadJobSpine's seq orderBy). A null envelope here means the terminal is
    // provisional → unschedulable (computeEnvelope would refuse anyway; we
    // refuse with the same code up front).
    const routes = routeEntries.map(([key, unitIds]) => {
      const ids = new Set(spine.rawProcesses.filter((p) => inRoute(p, key)).map((p) => p.id));
      const processes = spine.processes.filter((p) => ids.has(p.id));
      const edges = spine.edges.filter((e) => ids.has(e.processId) && ids.has(e.predecessorId));
      if (!processes.some((p) => p.included !== false)) {
        throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
          jobId: parsed.jobId,
          reason: 'no included processes to schedule',
          ...(key != null ? { equipmentId: key } : {}),
        });
      }
      const terminal = selectTerminal(processes, edges);
      if (terminal.envelopeFinishByMaxDays == null || terminal.envelopeFinishByMinDays == null) {
        throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
          processId: terminal.id,
          code: terminal.code,
        });
      }
      return { key, unitIds, processes, terminal };
    });

    // Planning dates a planner legitimately supplies at tender stage are NOT
    // actuals (invariant #1) — the request schema is .strict(); these fall back
    // to the job's own order/delivery dates.
    const orderDate = parsed.projectStartDate ?? spine.job.orderDate;
    const deliveryDate = parsed.requiredDeliveryDate ?? spine.job.committedDeliveryDate;

    // Project-start anchor per mode. BACKWARD: the longest route decides, so every line can finish by the delivery date.
    let projectStart: Date;
    if (parsed.mode === 'BACKWARD') {
      if (!deliveryDate) {
        throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
          jobId: parsed.jobId,
          reason: 'BACKWARD schedule needs a required delivery date',
          missing: 'committedDeliveryDate',
        });
      }
      projectStart = routes
        .map((r) =>
          subtractWorkingDays(deliveryDate, r.terminal.envelopeFinishByMaxDays!, spine.calendar),
        )
        .reduce((a, b) => (b < a ? b : a));
    } else {
      if (!orderDate) {
        throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
          jobId: parsed.jobId,
          reason: 'FORWARD schedule needs an order/project-start date',
        });
      }
      projectStart = orderDate;
    }

    // ponytail: planned = the standard (max) envelope — the committed deadline a
    // department is held to, matching CPM's MAX-duration basis. For the PV v1
    // pilot min==max so it is moot; if a family ever ships a real min/max spread
    // and DESPL wants the optimistic edge planned instead, switch to *Min here.
    const deptByProc = new Map(spine.rawProcesses.map((p) => [p.id, p.departmentId]));

    // Feasibility is a tender-stage check: only meaningful when we know both the
    // order window's ends. Missing either → leave feasibility unstamped. With
    // several routes the worst one is the job's.
    const feasOrder = { FEASIBLE: 0, TIGHT: 1, INFEASIBLE: 2 } as const;
    let feas: ReturnType<typeof checkFeasibility> | null = null;
    const plans: PlanInput[] = [];
    for (const r of routes) {
      // Layer 1 — authoritative planned dates. Throws SCHEDULE_DATA_MISSING for
      // any provisional/duration-less included process (let it surface).
      const envelope = computeEnvelope(r.processes, projectStart, spine.calendar);
      if (orderDate && deliveryDate) {
        const f = checkFeasibility(
          orderDate,
          deliveryDate,
          r.terminal.envelopeFinishByMinDays!,
          r.terminal.envelopeFinishByMaxDays!,
          spine.calendar,
        );
        if (
          feas == null ||
          feasOrder[f.feasibility] > feasOrder[feas.feasibility] ||
          (f.feasibility === feas.feasibility && (f.shortfallDays ?? 0) > (feas.shortfallDays ?? 0))
        ) {
          feas = f;
        }
      }
      // Per-unit grain: one plan per (included process × unit).
      // ponytail: all units share the route's envelope dates in v1 — per-serial
      // stagger is a Phase-2 sequencing concern, not modelled here.
      const unitIds: (number | null)[] = r.unitIds.length > 0 ? r.unitIds : [null];
      for (const unitId of unitIds) {
        for (const e of envelope) {
          plans.push({
            jobProcessId: e.processId,
            ownerDepartmentId: deptByProc.get(e.processId)!,
            unitId,
            baselineStart: e.plannedStartMax,
            baselineFinish: e.plannedFinishMax,
            plannedStart: e.plannedStartMax,
            plannedFinish: e.plannedFinishMax,
          });
        }
      }
    }

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
 * The job's one current schedule run (with plans), or null (AUD-034: one
 * current run per job, full stop — no equipmentId grain to select between
 * any more). Read-only: any actor who can see the job's client may read it
 * (client viewers included).
 */
export async function getSchedule(
  actor: Actor,
  jobId: number,
): Promise<ScheduleRunWithPlans | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: 'Job', jobId });
    assertClientScope(actor, job.clientId);
    return getCurrentScheduleRun(tx, jobId);
  });
}
