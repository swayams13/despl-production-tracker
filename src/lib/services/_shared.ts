import { Decimal } from "@prisma/client/runtime/library";
import type { Tx } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES, isAppError } from "@/lib/shared/errors";
import { DEFAULT_CALENDAR, computeCpm } from "@/lib/schedule";
import { istCalendarDayMarker } from "@/lib/shared/business-day";
import { explodeBomItem, type ExplodableBomItem } from "./bom-explosion";
import type {
  ScheduleProcess,
  ScheduleEdge,
  WorkCalendarInput,
  PredecessorState,
  CpmNode,
} from "@/lib/schedule";
import type {
  Job,
  JobProcess,
  JobProcessEdge,
  ProcessPlan,
  ScheduleRun,
  ScheduleMode,
  ScheduleFeasibility,
  OperationStatus,
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

// ── CPM guards (audit 0.10) ─────────────────────────────────────────────

/**
 * Bare Errors from the CPM (cycle, dangling edge, an excluded node with no
 * duration for bypassExcluded to compose through) become an explainable
 * refusal (invariant #12); AppErrors (e.g. SCHEDULE_DATA_MISSING) pass
 * through unchanged. Use for a single-job read/write path, where the caller
 * already has a jobId to report the failure against — override.service.ts's
 * original helper, promoted here so every CPM call site shares it.
 */
export function computeOrRefuse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (isAppError(e)) throw e;
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * computeCpm, but for a loop over EVERY job in the tenant (My Day, Command
 * Center): one job with a malformed spine — a cycle, a dangling edge, an
 * excluded provisional process with no confirmed duration — must not 500 the
 * whole page for every other job. Returns null on any failure so the caller
 * can skip just that job's contribution and keep going (audit H2/0.10).
 */
export function computeCpmSafe(processes: ScheduleProcess[], edges: ScheduleEdge[]): CpmNode[] | null {
  try {
    return computeCpm(processes, edges);
  } catch {
    return null;
  }
}

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

  // orderBy is load-bearing, not cosmetic: schedule.service.ts's terminal-node
  // selection ties on envelopeFinishByMaxDays for parallel branches and
  // tie-breaks on array order — an unordered findMany lets Postgres return rows
  // in any order, so which tied process "wins" (and therefore which
  // envelopeFinishByMinDays feeds checkFeasibility) becomes nondeterministic
  // (audit 0.9).
  const rawProcesses = await tx.jobProcess.findMany({ where: { jobId }, orderBy: { seq: "asc" } });
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
/** (jobProcessId, unitId) → the prior run's actuals for that cell, carried forward on reschedule. */
function priorActualsKey(jobProcessId: number, unitId: number | null): string {
  return `${jobProcessId}:${unitId ?? "null"}`;
}

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

  // Reschedule must not orphan in-flight actuals (audit C1): the prior current
  // run's plans carry real floor work — actualStart/actualFinish/submittedBy/
  // verifiedBy/status — and every read filters isCurrent, so demoting the run
  // without carrying them forward makes that work invisible everywhere. Read
  // the prior current run's plans BEFORE demoting it (still readable either way
  // since demote only flips isCurrent, not the rows) and key them by the same
  // (jobProcessId, unitId) grain the new plans are built on.
  const priorRun = await tx.scheduleRun.findFirst({
    where: { jobId, equipmentId, isCurrent: true },
    include: { processPlans: true },
  });
  const priorByKey = new Map(
    (priorRun?.processPlans ?? []).map((p) => [priorActualsKey(p.jobProcessId, p.unitId), p]),
  );

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
        create: input.plans.map((p) => {
          const prior = priorByKey.get(priorActualsKey(p.jobProcessId, p.unitId));
          return {
            jobProcessId: p.jobProcessId,
            unitId: p.unitId,
            baselineStart: p.baselineStart,
            baselineFinish: p.baselineFinish,
            plannedStart: p.plannedStart,
            plannedFinish: p.plannedFinish,
            ownerDepartmentId: p.ownerDepartmentId,
            status: prior?.status ?? "NOT_STARTED",
            actualStart: prior?.actualStart ?? null,
            actualFinish: prior?.actualFinish ?? null,
            submittedBy: prior?.submittedBy ?? null,
            verifiedBy: prior?.verifiedBy ?? null,
          };
        }),
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
 * if the plan does not exist OR belongs to another tenant.
 *
 * `process_plans` is NOT in the RLS `tenant_tables` set (it has no tenantId
 * column), so — unlike jobs/users — a bare findUnique by id would happily
 * return another tenant's row and every caller here is the last check before
 * a write. The read is therefore anchored through `ownerDepartment`, which IS
 * RLS-covered, and a cross-tenant id reads exactly like "doesn't exist" so
 * nothing leaks about other tenants' data.
 *
 * // ponytail: the FOR UPDATE lock below is left unscoped — locking a row
 * // that turns out to belong to another tenant is wasted work inside a
 * // doomed transaction, not a data leak; the scoped read right after it is
 * // what decides whether anything is returned.
 *
 * Also refuses a write against a plan whose ScheduleRun has been superseded
 * (audit C1's aggravator): a reschedule flips the prior run's isCurrent to
 * false but never mutates its ProcessPlan rows, so a stale client tab open on
 * an old plan id could otherwise still Start/Submit/Verify against a run
 * nothing reads from anymore — passing gating while being invisible everywhere.
 */
export async function lockProcessPlanForUpdate(
  tx: Tx,
  processPlanId: number,
  tenantId: number,
): Promise<ProcessPlan> {
  await tx.$queryRaw`SELECT id FROM process_plans WHERE id = ${processPlanId} FOR UPDATE`;
  const row = await tx.processPlan.findFirst({
    where: { id: processPlanId, ownerDepartment: { tenantId } },
  });
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessPlan", processPlanId });
  const run = await tx.scheduleRun.findUnique({ where: { id: row.scheduleRunId }, select: { isCurrent: true } });
  if (!run?.isCurrent) throw new AppError(ERROR_CODES.STALE_WRITE, { entity: "ProcessPlan", processPlanId });
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
      plannedFinish: { lt: istCalendarDayMarker() },
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

// ── Component/assembly rollup (Phase 3, addendum §3) ────────────────────

export interface MappedOp {
  source: "fabrication" | "assembly";
  label: string;
  status: OperationStatus;
}

/**
 * Every `ComponentOperation`/`AssemblyStep` on `unitId` that rolls up into
 * `jobProcessId`, joined by value (`OperationRef.leadTimeProcessSeq` /
 * `AssemblyTemplateStep.leadTimeProcessSeq` == `JobProcess.code` as a
 * number) — the same discipline `bom.read.ts`'s QCP-checkpoint lookup
 * already uses for the fabrication half. Empty when `unitId` is null
 * (job/equipment grain, no serial to roll up yet) or when this process has
 * no mapped operations at all — both are SEAM cases, not errors.
 */
export async function loadMappedOps(
  tx: Tx,
  args: { jobProcessId: number; unitId: number | null },
): Promise<MappedOp[]> {
  if (args.unitId == null) return [];

  const jobProcess = await tx.jobProcess.findUnique({
    where: { id: args.jobProcessId },
    select: { code: true },
  });
  if (!jobProcess || !/^\d+$/.test(jobProcess.code)) return [];
  const seq = Number(jobProcess.code);

  const [componentOps, assemblySteps] = await Promise.all([
    tx.componentOperation.findMany({
      where: { component: { unitId: args.unitId }, operation: { leadTimeProcessSeq: seq } },
      select: { status: true, operation: { select: { name: true } } },
    }),
    tx.assemblyStep.findMany({
      where: { unitId: args.unitId, templateStep: { leadTimeProcessSeq: seq } },
      select: { status: true, templateStep: { select: { activity: true } } },
    }),
  ]);

  return [
    ...componentOps.map((o) => ({ source: "fabrication" as const, label: o.operation.name, status: o.status })),
    ...assemblySteps.map((s) => ({ source: "assembly" as const, label: s.templateStep.activity, status: s.status })),
  ];
}

/**
 * `submitProcess` gate (Phase 3, R2 / PRD FR-C2): refuses when a mapped
 * fabrication or assembly operation on this (process, unit) is not yet
 * COMPLETE. No-op when nothing is mapped — see `loadMappedOps`.
 */
export async function assertComponentOpsComplete(
  tx: Tx,
  args: { jobProcessId: number; unitId: number | null },
): Promise<void> {
  const ops = await loadMappedOps(tx, args);
  const incomplete = ops.filter((o) => o.status !== "COMPLETE");
  if (incomplete.length > 0) {
    throw new AppError(ERROR_CODES.COMPONENT_OPS_INCOMPLETE, {
      jobProcessId: args.jobProcessId,
      unitId: args.unitId,
      incompleteOperations: incomplete.map((o) => o.label),
    });
  }
}

/**
 * B7, Phase 4 (CLAUDE.md #2's fourth gate): a component's linked `BomItem`
 * must not be recorded short before its next operation starts. SEAM, same
 * convention as `assertComponentOpsComplete`/`assertNoOpenHoldPoint`: no-op
 * (nothing to check) when `Component.bomItemId` is null (untracked part), or
 * when the `BomItem` has zero `StockLot` rows at all (never tracked, distinct
 * from "zero available" — B6's `availableQty`/`shortage` SEAM convention).
 *
 * `bom.read.ts`'s exported `requiredQty`/`availableQty`/`shortage` each open
 * their own `withTenant` transaction — calling them here would nest a
 * transaction inside the caller's already-open one, which Prisma's
 * interactive-transaction client doesn't support. So the required/available
 * arithmetic is re-implemented inline against `tx`, the same way
 * `bom.read.ts`'s `loadBomTree` already does it for the same reason (see its
 * comment above `itemsById`) — not a divergent copy, the established pattern
 * for "needs the same numbers but from inside a transaction."
 */
export async function assertKitReady(tx: Tx, componentId: number, tenantId: number): Promise<void> {
  const component = await tx.component.findFirst({
    where: { id: componentId, equipment: { job: { tenantId } } },
    select: { bomItemId: true },
  });
  if (!component) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Component", componentId });
  if (component.bomItemId == null) return; // SEAM: no BOM link, nothing to check

  const bomItem = await tx.bomItem.findFirst({
    where: { id: component.bomItemId, equipment: { job: { tenantId } } },
    select: {
      id: true,
      partName: true,
      equipmentId: true,
      qtyPer: true,
      parentBomItemId: true,
      stockLots: { select: { qty: true, txns: { select: { type: true, qty: true } } } },
    },
  });
  if (!bomItem) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomItem", bomItemId: component.bomItemId });
  if (bomItem.stockLots.length === 0) return; // SEAM: zero stock activity recorded at all — never tracked stays silent

  const [unitCount, siblingItems] = await Promise.all([
    tx.unit.count({ where: { equipmentId: bomItem.equipmentId } }),
    tx.bomItem.findMany({
      where: { equipmentId: bomItem.equipmentId },
      select: { id: true, qtyPer: true, parentBomItemId: true },
    }),
  ]);
  const itemsById = new Map<number, ExplodableBomItem>(siblingItems.map((it) => [it.id, it]));

  let required: Decimal;
  try {
    required = explodeBomItem(itemsById.get(bomItem.id)!, unitCount, itemsById);
  } catch {
    return; // unparsed qtyPer somewhere in the chain, or a cycle — nothing display-worthy to check (same fallback as loadBomTree)
  }

  let available = bomItem.stockLots.reduce((sum, lot) => sum.plus(lot.qty), new Decimal(0));
  for (const lot of bomItem.stockLots) {
    for (const t of lot.txns) {
      available = t.type === "RETURN" ? available.plus(t.qty) : available.minus(t.qty);
    }
  }

  const shortfall = required.minus(available);
  if (shortfall.gt(0)) {
    throw new AppError(ERROR_CODES.MATERIAL_NOT_AVAILABLE, {
      componentId,
      bomItemId: bomItem.id,
      partName: bomItem.partName,
      shortage: shortfall.toNumber(),
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
