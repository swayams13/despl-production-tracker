import type { Tx } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { DEFAULT_CALENDAR } from "@/lib/schedule";
import type {
  ScheduleProcess,
  ScheduleEdge,
  WorkCalendarInput,
  PredecessorState,
} from "@/lib/schedule";
import type {
  Job,
  JobProcess,
  JobProcessEdge,
  ProcessPlan,
  ScheduleRun,
  ScheduleMode,
  ScheduleFeasibility,
} from "@/generated/prisma/client";

/**
 * Cross-cutting helpers the four service files sit on. Two jobs only:
 *   1. map Prisma rows ↔ the pure lib/schedule engine's shapes, and
 *   2. own the transactional primitives every service repeats — load the job
 *      spine, persist a versioned ScheduleRun, lock a plan row, and run the
 *      invariant gate checks that read from source tables (delay block, hold
 *      point, predecessor state).
 *
 * Everything here runs inside a `withTenant` transaction the caller already
 * opened — these take the `tx`, never the bare client (db.ts).
 */

// ── Row → engine mappers ────────────────────────────────────────────────

/**
 * JobProcess → engine ScheduleProcess.
 *
 * A confirmed `durationOverrideDays` is the planner's authoritative duration:
 * it replaces min/max AND clears `provisional`, matching the engine's own
 * resolveDuration (an override in its map makes even a provisional process
 * schedulable). `included` passes through so bypassExcluded/computeEnvelope
 * splice or drop the node.
 *
 * // ponytail: an override drives CPM/replanning (Layer 2) only — it does NOT
 * // recompute the printed envelope offsets (Layer 1 stays authoritative). The
 * // OVERRIDE-mode ScheduleRun path recomputes CPM from the override; the
 * // envelope is left as fitted. Recompute envelope from overrides only if
 * // DESPL ever wants a duration edit to move the authoritative planned dates.
 */
export function jobProcessToScheduleProcess(row: JobProcess): ScheduleProcess {
  const overridden = row.durationOverrideDays != null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    durationMinDays: row.durationOverrideDays ?? row.durationMinDays,
    durationMaxDays: row.durationOverrideDays ?? row.durationMaxDays,
    envelopeFinishByMinDays: row.envelopeFinishByMinDays,
    envelopeFinishByMaxDays: row.envelopeFinishByMaxDays,
    envelopeStartByMinDays: row.envelopeStartByMinDays,
    envelopeStartByMaxDays: row.envelopeStartByMaxDays,
    provisional: overridden ? false : row.provisional,
    included: row.included,
  };
}

/** JobProcessEdge → engine ScheduleEdge (the enum strings already line up). */
export function jobEdgeToScheduleEdge(row: JobProcessEdge): ScheduleEdge {
  return {
    processId: row.processId,
    predecessorId: row.predecessorId,
    type: row.type,
    lagDays: row.lagDays,
  };
}

// ── Job spine loader ─────────────────────────────────────────────────────

export interface JobSpine {
  job: Job;
  /** Mapped for the engine. */
  processes: ScheduleProcess[];
  /** Mapped for the engine. */
  edges: ScheduleEdge[];
  calendar: WorkCalendarInput;
  /** Raw JobProcess rows the caller still needs (ownerDepartmentId per process). */
  rawProcesses: JobProcess[];
}

/**
 * Load a job, its process spine + edges, and its resolved work calendar,
 * mapped to engine shapes. Calendar resolution: Job.calendarId →
 * tenant-default calendar → the engine's DEFAULT_CALENDAR.
 *
 * Throws NOT_FOUND if the job is absent or invisible (RLS returns zero rows
 * for another tenant, so `null` here covers both).
 */
export async function loadJobSpine(tx: Tx, jobId: number): Promise<JobSpine> {
  const job = await tx.job.findUnique({ where: { id: jobId } });
  if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });

  const rawProcesses = await tx.jobProcess.findMany({ where: { jobId } });
  const rawEdges = await tx.jobProcessEdge.findMany({ where: { process: { jobId } } });

  let cal =
    job.calendarId != null
      ? await tx.workCalendar.findUnique({
          where: { id: job.calendarId },
          include: { holidays: true },
        })
      : null;
  if (!cal) {
    cal = await tx.workCalendar.findFirst({
      where: { isDefault: true },
      include: { holidays: true },
    });
  }
  const calendar: WorkCalendarInput = cal
    ? { weekOffDays: cal.weekOffDays, holidays: cal.holidays.map((h) => h.date) }
    : DEFAULT_CALENDAR;

  return {
    job,
    processes: rawProcesses.map(jobProcessToScheduleProcess),
    edges: rawEdges.map(jobEdgeToScheduleEdge),
    calendar,
    rawProcesses,
  };
}

// ── ScheduleRun persistence ──────────────────────────────────────────────

/** One ProcessPlan to write; unitId null = job/equipment grain, else per-serial. */
export interface PlanInput {
  jobProcessId: number;
  ownerDepartmentId: number;
  unitId: number | null;
  baselineStart: Date | null;
  baselineFinish: Date | null;
  plannedStart: Date | null;
  plannedFinish: Date | null;
}

export interface PersistScheduleRunInput {
  jobId: number;
  equipmentId: number | null;
  mode: ScheduleMode;
  projectStartDate: Date;
  requiredDeliveryDate: Date | null;
  feasibility: ScheduleFeasibility | null;
  shortfallDays: number | null;
  overrideReason: string | null;
  plans: PlanInput[];
}

export type ScheduleRunWithPlans = ScheduleRun & { processPlans: ProcessPlan[] };

/**
 * Persist a new schedule as the next version for (jobId, equipmentId): demote
 * every current sibling run, insert this one as isCurrent, write its
 * ProcessPlan rows (unitId per the input PlanInput — null at job/equipment
 * grain, per-serial when the caller expands per unit; status NOT_STARTED),
 * and audit it — all in the caller's transaction. Never mutates a prior run's
 * rows (invariant #6): an override is a NEW version, the old baseline stays intact.
 */
export async function persistScheduleRun(
  tx: Tx,
  actor: Actor,
  input: PersistScheduleRunInput,
): Promise<ScheduleRunWithPlans> {
  const { jobId, equipmentId } = input;

  // Serialize concurrent schedule generation per job. The (jobId, equipmentId,
  // version) unique index is NULL-distinct in Postgres and equipmentId is null
  // at the job grain, so it cannot stop two isCurrent runs racing to the same
  // version. Lock the parent job row FOR UPDATE so read-max-version → demote →
  // insert is atomic across overlapping calls (double-click, retry, two planners).
  // ponytail: per-job row lock; a partial unique index on (job_id) WHERE
  // is_current is the DB-native alternative if this lock ever contends.
  await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;

  const prev = await tx.scheduleRun.aggregate({
    _max: { version: true },
    where: { jobId, equipmentId },
  });
  const version = (prev._max.version ?? 0) + 1;

  await tx.scheduleRun.updateMany({
    where: { jobId, equipmentId, isCurrent: true },
    data: { isCurrent: false },
  });

  const run = await tx.scheduleRun.create({
    data: {
      jobId,
      equipmentId,
      version,
      mode: input.mode,
      projectStartDate: input.projectStartDate,
      requiredDeliveryDate: input.requiredDeliveryDate,
      feasibility: input.feasibility,
      shortfallDays: input.shortfallDays,
      isCurrent: true,
      overrideReason: input.overrideReason,
      createdBy: actor.userId,
      processPlans: {
        create: input.plans.map((p) => ({
          jobProcessId: p.jobProcessId,
          unitId: p.unitId,
          baselineStart: p.baselineStart,
          baselineFinish: p.baselineFinish,
          plannedStart: p.plannedStart,
          plannedFinish: p.plannedFinish,
          ownerDepartmentId: p.ownerDepartmentId,
          status: "NOT_STARTED",
        })),
      },
    },
    include: { processPlans: true },
  });

  await recordAudit(tx, actor, {
    action: "schedule.generate",
    entityType: "ScheduleRun",
    entityId: run.id,
    after: {
      version,
      mode: input.mode,
      feasibility: input.feasibility,
      shortfallDays: input.shortfallDays,
      isCurrent: true,
      planCount: run.processPlans.length,
    },
    eventType: "ScheduleRunCreated",
    eventPayload: { jobId, equipmentId, version, mode: input.mode },
  });

  return run;
}

/** The current run for (jobId, equipmentId) with its plans, or null. Undefined equipmentId means the job-level grain (equipmentId null). */
export async function getCurrentScheduleRun(
  tx: Tx,
  jobId: number,
  equipmentId?: number | null,
): Promise<ScheduleRunWithPlans | null> {
  return tx.scheduleRun.findFirst({
    where: { jobId, equipmentId: equipmentId ?? null, isCurrent: true },
    include: { processPlans: true },
  });
}

// ── Row locking ──────────────────────────────────────────────────────────

/**
 * Lock a ProcessPlan row FOR UPDATE, then return it. The gate check +
 * maker-checker + status write must serialize on this row (ARCHITECTURE §3/§6):
 * take the lock BEFORE re-reading predecessor state and writing, so two
 * concurrent transitions on the same plan cannot interleave. Throws NOT_FOUND
 * if the plan does not exist (or is invisible to this tenant).
 */
export async function lockProcessPlanForUpdate(
  tx: Tx,
  processPlanId: number,
): Promise<ProcessPlan> {
  await tx.$queryRaw`SELECT id FROM process_plans WHERE id = ${processPlanId} FOR UPDATE`;
  const row = await tx.processPlan.findUnique({ where: { id: processPlanId } });
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessPlan", processPlanId });
  return row;
}

// ── Invariant gates that read from source tables ─────────────────────────

/**
 * Invariant #7: a department with an OVERDUE plan (plannedFinish < now, not
 * COMPLETE) on this unit and no DelayReason filed is blocked from further
 * progress writes on the unit until a categorised reason is filed.
 */
export async function assertNoUnfiledDelayBlock(
  tx: Tx,
  args: { ownerDepartmentId: number; scheduleRunId: number; unitId: number | null },
): Promise<void> {
  const overdue = await tx.processPlan.findFirst({
    where: {
      scheduleRunId: args.scheduleRunId,
      ownerDepartmentId: args.ownerDepartmentId,
      unitId: args.unitId ?? null,
      status: { not: "COMPLETE" },
      plannedFinish: { lt: new Date() },
      delayReasons: { none: {} },
    },
    select: { id: true, jobProcessId: true, plannedFinish: true },
  });
  if (overdue) {
    throw new AppError(ERROR_CODES.REASON_REQUIRED, {
      ownerDepartmentId: args.ownerDepartmentId,
      overdueProcessPlanId: overdue.id,
      jobProcessId: overdue.jobProcessId,
    });
  }
}

/**
 * Invariant #4: a process with an uncleared hold-point QCP checkpoint on this
 * unit cannot complete. A checkpoint blocks when its QcpCodeRef.blocksCompletion
 * is set for any party, and its latest QcpExecution for the unit is not
 * ACCEPTED/NA (or has no execution at all).
 *
 * // ponytail: SEAM, not yet load-bearing. With no unitId (job/equipment grain,
 * // before per-serial expansion) or no blocksCompletion links there is nothing
 * // to block, so it passes — the real QcpExecution engine is what makes this
 * // bite. The query below is real, not a stub: when executions start being
 * // recorded per unit this enforces without a code change here.
 */
export async function assertNoOpenHoldPoint(
  tx: Tx,
  args: { jobProcessId: number; unitId: number | null },
): Promise<void> {
  if (args.unitId == null) return;

  const blockingItems = await tx.qcpItem.findMany({
    where: {
      processLinks: { some: { jobProcessId: args.jobProcessId } },
      partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
    },
    select: { id: true },
  });
  if (blockingItems.length === 0) return;

  const itemIds = blockingItems.map((i) => i.id);
  const execs = await tx.qcpExecution.findMany({
    where: { unitId: args.unitId, qcpItemId: { in: itemIds } },
    orderBy: { attemptNo: "desc" },
    select: { qcpItemId: true, result: true },
  });

  // Latest attempt per item.
  const latestByItem = new Map<number, string>();
  for (const e of execs) if (!latestByItem.has(e.qcpItemId)) latestByItem.set(e.qcpItemId, e.result);

  const open = itemIds.filter((itemId) => {
    const r = latestByItem.get(itemId);
    return r !== "ACCEPTED" && r !== "NA"; // undefined (no exec), PENDING, REJECTED all block
  });
  if (open.length > 0) {
    throw new AppError(ERROR_CODES.HOLD_POINT_OPEN, {
      jobProcessId: args.jobProcessId,
      unitId: args.unitId,
      openQcpItemIds: open,
    });
  }
}

// ── Notification context ────────────────────────────────────────────────

/** Enough context to build a human-readable notification title/deep-link for a plan. */
export interface PlanNotifyContext {
  jobId: number;
  jobNumber: string;
  unitId: number | null;
  serialNo: string | null;
  stageNo: number;
  processName: string;
  deptName: string;
}

export async function loadPlanNotifyContext(tx: Tx, plan: ProcessPlan): Promise<PlanNotifyContext> {
  const [jp, dept, unit] = await Promise.all([
    tx.jobProcess.findUniqueOrThrow({
      where: { id: plan.jobProcessId },
      select: { name: true, workOrderStages: true, job: { select: { id: true, jobNumber: true } } },
    }),
    tx.department.findUniqueOrThrow({ where: { id: plan.ownerDepartmentId }, select: { name: true } }),
    plan.unitId != null ? tx.unit.findUnique({ where: { id: plan.unitId }, select: { serialNo: true } }) : Promise.resolve(null),
  ]);
  return {
    jobId: jp.job.id,
    jobNumber: jp.job.jobNumber,
    unitId: plan.unitId,
    serialNo: unit?.serialNo ?? null,
    stageNo: jp.workOrderStages[0] ?? 0,
    processName: jp.name,
    deptName: dept.name,
  };
}

/**
 * The engine's PredecessorState[] for a process's incoming edges, read from
 * source ProcessPlan rows in this run for the given unit (unitId null =
 * job/equipment grain). A predecessor with no plan row yet counts as
 * NOT_STARTED (blocks, never throws). Feed straight into
 * assertCanStart/assertCanComplete.
 */
export async function loadPredecessorStates(
  tx: Tx,
  scheduleRunId: number,
  jobProcessId: number,
  unitId: number | null,
): Promise<PredecessorState[]> {
  const edges = await tx.jobProcessEdge.findMany({
    where: { processId: jobProcessId },
    select: { predecessorId: true },
  });
  if (edges.length === 0) return [];

  const predIds = edges.map((e) => e.predecessorId);
  const plans = await tx.processPlan.findMany({
    where: { scheduleRunId, jobProcessId: { in: predIds }, unitId: unitId ?? null },
    select: { jobProcessId: true, status: true },
  });
  const statusByProc = new Map(plans.map((p) => [p.jobProcessId, p.status]));

  return predIds.map((predecessorId) => ({
    predecessorId,
    status: statusByProc.get(predecessorId) ?? "NOT_STARTED",
  }));
}
