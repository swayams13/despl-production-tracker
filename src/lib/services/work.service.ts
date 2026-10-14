import { Prisma } from "@/generated/prisma/client";
import { withJob, withTenant, type Tx } from "@/lib/db";
import { type Actor, assertNotClientUser, hasRole, requireDepartmentScope, requireRole, ROLES } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES, isAppError, SEQUENCE_OVERRIDE_OPERATOR_MESSAGE, type ErrorCode } from "@/lib/shared/errors";
import { checkReportedAt, checkStart, OFFICE_PROCESS_MAX_SEQ, type FloorItem, type WorkKind } from "@/lib/shared/floor-rules";
import { istCalendarDayMarker } from "@/lib/shared/business-day";
import { inspectSchema, recordWorkSchema, type InspectInput, type RecordWorkInput } from "@/lib/shared/schemas";
import type { WorkCalendarInput } from "@/lib/schedule";
import {
  assertEvidenceSatisfied,
  assertNoOpenHoldPoint,
  assertNoOpenNcr,
  loadMappedOps,
  loadPlanNotifyContext,
  lockFloorUnits,
  lockProcessPlanForUpdate,
  resolveCalendarsForJobs,
  rollupForAssemblyStep,
  rollupForComponentOperation,
  rollupProcessPlan,
  type RollupChange,
} from "./_shared";
import { inspectAssemblyStepTx } from "./assembly.service";
import { rejectComponentOperationTx, verifyComponentOperationTx } from "./component.service";
import { rejectProcess, verifyProcess } from "./process.service";
import { loadFloorFacts, rowKey, type FloorFacts, type WorkRow } from "./work.facts";
import { assertPerformedByValid } from "./welding.service";
import { notify, userIdsWithRole } from "./notifications.service";

/**
 * Lean Core L1.2: the one floor write path. Start or Done on a batch of
 * component operations, assembly steps and (non-derived) process plans of ONE
 * job, gated by the D2 registry in floor-rules.ts — HARD rules refuse, SOFT
 * order needs an override reason. Process edges are schedule-only: this never
 * calls assertCanStart / assertCanComplete / assertNoUnfiledDelayBlock.
 *
 * One transaction, partial success: every refusal is an AppError thrown
 * before that item writes, caught and reported; any other error (SQL, audit
 * insert) aborts the whole batch. Locks: the floor advisory lock per unit
 * (ascending), then FOR UPDATE on every item row (sorted by kind, id).
 */

export interface WorkApplied {
  kind: WorkKind;
  id: number;
  from: string;
  to: string;
  overridden: boolean;
  late: boolean;
}
export interface WorkRefused {
  kind: WorkKind;
  id: number;
  code: ErrorCode;
  message: string;
  meta: Record<string, unknown>;
}
export interface RecordWorkResult {
  applied: WorkApplied[];
  refused: WorkRefused[];
  rolledUp: RollupChange[];
  replayed?: true;
}

const ENTITY: Record<WorkKind, string> = {
  COMPONENT_OP: "ComponentOperation",
  ASSEMBLY_STEP: "AssemblyStep",
  PROCESS_PLAN: "ProcessPlan",
};
const START_ACTIONS: Record<WorkKind, string[]> = {
  COMPONENT_OP: ["componentOperation.start", "work.start", "work.done"],
  ASSEMBLY_STEP: ["assemblyStep.start", "work.start", "work.done"],
  PROCESS_PLAN: ["process.start", "work.start", "work.done"],
};
/** Who records floor work (review fix, 14 Oct). PLANNER: processes 1–11 only. */
const FLOOR_ROLES = [ROLES.OPERATOR, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN] as const;
const JOINT_REQUIRED =
  "This weld step needs a joint bound before it can be marked done. Pick an existing joint, or log it first.";

type Item = RecordWorkInput["items"][number];

/** unitId (null = job level) of every item that belongs to this job; absent = not in this job. */
async function resolveUnits(tx: Tx, jobId: number, items: Item[]): Promise<Map<string, number | null>> {
  const ids = (k: WorkKind) => items.filter((i) => i.kind === k).map((i) => i.id);
  const [steps, ops, plans] = await Promise.all([
    tx.assemblyStep.findMany({ where: { id: { in: ids("ASSEMBLY_STEP") }, jobId }, select: { id: true, unitId: true } }),
    tx.componentOperation.findMany({
      where: { id: { in: ids("COMPONENT_OP") }, jobId },
      select: { id: true, component: { select: { unitId: true } } },
    }),
    tx.processPlan.findMany({ where: { id: { in: ids("PROCESS_PLAN") }, jobId }, select: { id: true, unitId: true } }),
  ]);
  return new Map<string, number | null>([
    ...steps.map((s) => [rowKey("ASSEMBLY_STEP", s.id), s.unitId] as const),
    ...ops.map((o) => [rowKey("COMPONENT_OP", o.id), o.component.unitId] as const),
    ...plans.map((p) => [rowKey("PROCESS_PLAN", p.id), p.unitId] as const),
  ]);
}

/** FOR UPDATE on every item row, sorted by (kind, id): serialises with the legacy start/submit/verify paths. */
async function lockItemRows(tx: Tx, items: Item[]): Promise<void> {
  const ids = (k: WorkKind) => items.filter((i) => i.kind === k).map((i) => i.id).sort((a, b) => a - b);
  const steps = ids("ASSEMBLY_STEP");
  const ops = ids("COMPONENT_OP");
  const plans = ids("PROCESS_PLAN");
  if (steps.length) await tx.$queryRaw`SELECT id FROM assembly_steps WHERE id = ANY(${steps}::int[]) ORDER BY id FOR UPDATE`;
  if (ops.length) await tx.$queryRaw`SELECT id FROM component_operations WHERE id = ANY(${ops}::int[]) ORDER BY id FOR UPDATE`;
  if (plans.length) await tx.$queryRaw`SELECT id FROM process_plans WHERE id = ANY(${plans}::int[]) ORDER BY id FOR UPDATE`;
}

/** The earlier item a SOFT override skipped, closest first (SequenceOverride.predecessorTargetId). */
function nearest(open: FloorItem[]): FloorItem {
  const order = (i: FloorItem) =>
    i.kind === "ASSEMBLY_STEP" ? i.seq : i.kind === "COMPONENT_OP" ? i.routeSeq : (i.processSeq ?? 0);
  return open.reduce((a, b) => (order(b) > order(a) ? b : a));
}

export async function recordWork(actor: Actor, input: RecordWorkInput): Promise<RecordWorkResult> {
  const { requestId, jobId, action, items, override, lateReason, ...rest } = recordWorkSchema.parse(input);
  assertNotClientUser(actor);
  // Floor-write allowlist; a planner is further limited to processes 1–11 per item (applyItem).
  requireRole(actor, ...FLOOR_ROLES, ROLES.PLANNER);
  const reportedAt = rest.reportedAt ? new Date(rest.reportedAt) : null;

  return withJob(
    actor.tenantId,
    jobId,
    async (tx) => {
      const job = await tx.job.findFirst({
        where: { id: jobId, tenantId: actor.tenantId },
        select: { id: true, familyId: true, orderDate: true, calendarId: true, jobNumber: true },
      });
      if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });

      const unitOf = await resolveUnits(tx, job.id, items);
      await lockFloorUnits(tx, job.id, unitOf.values());

      // After the lock: a concurrent duplicate of this request has committed by now.
      if (requestId) {
        const prior = await tx.workRequest.findFirst({ where: { requestId } });
        if (prior) {
          if (prior.actorId !== actor.userId || prior.jobId !== job.id) {
            throw new AppError(ERROR_CODES.VALIDATION_FAILED, { requestId }, "This request id was already used for another request.");
          }
          return { ...(prior.response as unknown as RecordWorkResult), replayed: true as const };
        }
      }

      if (lateReason) {
        const category = await tx.delayCategoryRef.findFirst({
          where: { id: lateReason.categoryId, tenantId: actor.tenantId, active: true },
        });
        if (!category) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "DelayCategoryRef", categoryId: lateReason.categoryId });
      }

      await lockItemRows(tx, items);

      const factsByUnit = new Map<number | null, FloorFacts>();
      for (const unitId of new Set(unitOf.values())) factsByUnit.set(unitId, await loadFloorFacts(tx, job, unitId));

      const calendar = (await resolveCalendarsForJobs(tx, [job])).get(job.id) as WorkCalendarInput;
      const release = await tx.bomRevision.findFirst({
        where: { jobId: job.id, status: "RELEASED", releasedAt: { not: null } },
        orderBy: { releasedAt: "asc" },
        select: { releasedAt: true },
      });
      const now = new Date();
      const ctx: BatchContext = {
        tx,
        actor,
        job,
        action,
        reportedAt,
        now,
        calendar,
        releaseDate: release?.releasedAt ?? null,
        override,
        lateReason,
        requestId,
        categories: null,
      };

      const result: RecordWorkResult = { applied: [], refused: [], rolledUp: [] };
      const affectedPlans = new Map<number, { jobProcessId: number; unitId: number }>();
      const submitted = new Map<number | null, Array<{ kind: WorkKind; id: number }>>();

      for (const it of items) {
        const key = rowKey(it.kind, it.id);
        try {
          if (!unitOf.has(key)) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: ENTITY[it.kind], id: it.id });
          const facts = factsByUnit.get(unitOf.get(key)!)!;
          const row = facts.rows.get(key);
          // Resolved in this job but not in the current schedule run: a superseded plan.
          if (!row) throw new AppError(ERROR_CODES.STALE_WRITE, { entity: ENTITY[it.kind], id: it.id });

          const applied = await applyItem(ctx, facts, row, it.detail);
          result.applied.push(applied);
          if (applied.to === "SUBMITTED") {
            const list = submitted.get(row.unitId) ?? [];
            list.push({ kind: it.kind, id: it.id });
            submitted.set(row.unitId, list);
          }
          const plan = row.item.processSeq != null && it.kind !== "PROCESS_PLAN" ? facts.plansBySeq.get(row.item.processSeq) : undefined;
          if (plan?.unitId != null) affectedPlans.set(plan.item.id, { jobProcessId: plan.jobProcessId!, unitId: plan.unitId });
        } catch (e) {
          if (!isAppError(e)) throw e;
          result.refused.push({ kind: it.kind, id: it.id, code: e.code, message: e.message, meta: e.detail ?? {} });
        }
      }

      for (const planId of [...affectedPlans.keys()].sort((a, b) => a - b)) {
        const { jobProcessId, unitId } = affectedPlans.get(planId)!;
        const change = await rollupProcessPlan(tx, actor, jobProcessId, unitId);
        if (change) result.rolledUp.push(change);
      }

      await notifyQc(tx, actor, job, submitted);

      // Same JSON shape on the first answer and on a replay.
      const response = JSON.parse(JSON.stringify(result)) as RecordWorkResult;
      if (requestId) {
        // job_isolation RLS hides another job's row from the lookup above; the unique index still sees it.
        await tx.workRequest
          .create({ data: { jobId: job.id, requestId, actorId: actor.userId, response: response as never } })
          .catch((e: unknown) => {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
              throw new AppError(ERROR_CODES.VALIDATION_FAILED, { requestId }, "This request id was already used for another request.");
            }
            throw e;
          });
      }
      return response;
    },
    { timeoutMs: 30_000 },
  );
}

interface BatchContext {
  tx: Tx;
  actor: Actor;
  job: { id: number; orderDate: Date | null; jobNumber: string };
  action: "START" | "DONE";
  reportedAt: Date | null;
  now: Date;
  calendar: WorkCalendarInput;
  releaseDate: Date | null;
  override: RecordWorkInput["override"];
  lateReason: RecordWorkInput["lateReason"];
  requestId: string | undefined;
  categories: Array<{ id: number; code: string; name: string }> | null;
}

/** Throws an AppError (the refusal) before writing anything for this item. */
async function applyItem(ctx: BatchContext, facts: FloorFacts, row: WorkRow, detail: Item["detail"]): Promise<WorkApplied> {
  const { tx, actor, action, reportedAt, now } = ctx;
  const { item } = row;

  if (row.departmentId == null) {
    throw new AppError(ERROR_CODES.GATING_BLOCKED, { reason: "operation has no defaultDepartmentId configured" });
  }
  const office = item.kind === "PROCESS_PLAN" && item.processSeq != null && item.processSeq <= OFFICE_PROCESS_MAX_SEQ;
  if (!hasRole(actor, ...FLOOR_ROLES) && !office) {
    throw new AppError(ERROR_CODES.FORBIDDEN, { reason: "a planner records processes 1–11 only", kind: item.kind, id: item.id });
  }
  requireDepartmentScope(actor, row.departmentId);
  if (row.stepKind === "INSPECTION") throw new AppError(ERROR_CODES.INSPECT_REQUIRED, { assemblyStepId: item.id });
  if (row.derived) throw new AppError(ERROR_CODES.DERIVED_STATUS, { processPlanId: item.id });

  const from = item.status;
  const starting = from === "NOT_STARTED";
  if (!(starting || (action === "DONE" && from === "IN_PROGRESS"))) {
    const started = await tx.auditLog.findFirst({
      where: { tenantId: actor.tenantId, entityType: ENTITY[item.kind], entityId: String(item.id), action: { in: START_ACTIONS[item.kind] } },
      orderBy: { id: "desc" },
      select: { actorId: true },
    });
    throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, {
      entity: ENTITY[item.kind],
      action,
      currentStatus: from,
      startedBy: started?.actorId ?? null,
    });
  }

  if (reportedAt) {
    const reason = checkReportedAt({
      reportedAt,
      now,
      action,
      releaseDate: ctx.releaseDate,
      orderDate: ctx.job.orderDate,
      startedAt: starting ? null : row.startedAt,
      calendar: ctx.calendar,
    });
    if (reason) throw new AppError(ERROR_CODES.REPORTED_AT_OUT_OF_WINDOW, { reason });
  }

  // D2: HARD then SOFT, at START — including the implicit START of a DONE on a NOT_STARTED item.
  let overridden: FloorItem[] = [];
  if (starting) {
    const check = checkStart(item, facts.facts, { roles: actor.roles, hasOverride: !!ctx.override });
    if (!check.ok) {
      const operator = check.code === ERROR_CODES.SEQUENCE_OVERRIDE_REQUIRED && check.meta.canOverride === false;
      throw new AppError(check.code, check.meta, operator ? SEQUENCE_OVERRIDE_OPERATOR_MESSAGE : undefined);
    }
    overridden = check.overridden;
  }

  // Invariant 7 as revised: a late Done carries its reason in the same action.
  let late = false;
  let fileLateOn: WorkRow | null = null;
  if (action === "DONE") {
    const plan = item.kind === "PROCESS_PLAN" ? row : item.processSeq != null ? facts.plansBySeq.get(item.processSeq) : undefined;
    if (plan?.plannedFinish && plan.plannedFinish < istCalendarDayMarker(reportedAt ?? now)) {
      late = true;
      if (!plan.hasDelayReason) {
        if (!ctx.lateReason) {
          ctx.categories ??= await tx.delayCategoryRef.findMany({
            where: { tenantId: actor.tenantId, active: true },
            orderBy: { id: "asc" },
            select: { id: true, code: true, name: true },
          });
          throw new AppError(ERROR_CODES.LATE_REASON_REQUIRED, {
            processPlanId: plan.item.id,
            plannedFinish: plan.plannedFinish,
            categories: ctx.categories,
          });
        }
        fileLateOn = plan;
      }
    }
  }

  // Detail: validated before any write.
  if (detail) {
    if (item.kind !== "COMPONENT_OP" && (detail.qtyGood != null || detail.qtyRejected != null)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { field: "qtyGood" }, "Quantities apply to component operations only.");
    }
    if (item.kind !== "ASSEMBLY_STEP" && detail.weldJointId != null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { field: "weldJointId" }, "A weld joint applies to assembly steps only.");
    }
    // ponytail: a new joint needs a joint type and welders the batch shape does not carry; log it first (logWeldJoint).
    if (detail.newJoint) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { field: "newJoint" }, "Log the joint first, then pick it here.");
    }
    if (detail.weldJointId != null) {
      const joint = await tx.weldJoint.findFirst({
        where: { id: detail.weldJointId, jobId: ctx.job.id, OR: [{ unitId: row.unitId }, { unitId: null }] },
        select: { id: true },
      });
      if (!joint) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "WeldJoint", weldJointId: detail.weldJointId });
    }
    await assertPerformedByValid(tx, actor, detail.performedByWelderId, detail.performedByUserId);
  }
  if (action === "DONE" && row.templateJointRef != null && row.weldJointId == null && detail?.weldJointId == null) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { assemblyStepId: item.id, jointRef: row.templateJointRef }, JOINT_REQUIRED);
  }

  const to = action === "START" ? "IN_PROGRESS" : row.requiresQc ? "SUBMITTED" : "COMPLETE";
  // Invariant 4: a plan written straight to COMPLETE (no QC verify) passes what verifyProcess refuses on.
  if (item.kind === "PROCESS_PLAN" && to === "COMPLETE") {
    const args = { jobProcessId: row.jobProcessId!, unitId: row.unitId, jobId: ctx.job.id };
    await assertNoOpenHoldPoint(tx, args);
    await assertNoOpenNcr(tx, args);
    await assertEvidenceSatisfied(tx, args);
  }

  // ── Writes ──
  const times = {
    ...(starting ? { reportedStartAt: reportedAt ?? undefined } : {}),
    ...(action === "DONE" ? { reportedFinishAt: reportedAt ?? undefined, submittedBy: actor.userId } : {}),
  };
  const who = {
    performedByWelderId: detail?.performedByWelderId,
    performedByUserId: detail?.performedByUserId,
    remarks: detail?.remarks,
  };
  let written: Record<string, unknown>;
  let builtToRevisionId: number | undefined;
  if (item.kind === "PROCESS_PLAN") {
    written = await tx.processPlan.update({
      where: { id: item.id },
      data: {
        status: to,
        ...times,
        ...(starting ? { actualStart: now } : {}),
        ...(to === "COMPLETE" ? { actualFinish: now } : {}),
      },
      select: { status: true, actualStart: true, actualFinish: true, reportedStartAt: true, reportedFinishAt: true, submittedBy: true },
    });
  } else {
    const data = {
      status: to,
      ...times,
      ...who,
      ...(starting ? { startedAt: now } : {}),
      ...(to === "COMPLETE" ? { finishedAt: now } : {}),
    } as const;
    const select = { status: true, startedAt: true, finishedAt: true, reportedStartAt: true, reportedFinishAt: true, submittedBy: true } as const;
    written =
      item.kind === "ASSEMBLY_STEP"
        ? await tx.assemblyStep.update({ where: { id: item.id }, data: { ...data, weldJointId: detail?.weldJointId }, select })
        : await tx.componentOperation.update({
            where: { id: item.id },
            data: { ...data, qtyGood: detail?.qtyGood, qtyRejected: detail?.qtyRejected },
            select,
          });
    if (starting) {
      // N3: stamp an open rework NCR's start, never clobbering dispositionNcr's own stamp.
      await tx.ncr.updateMany({
        where: {
          status: "REWORK_IN_PROGRESS",
          reworkStartedAt: null,
          ...(item.kind === "ASSEMBLY_STEP"
            ? { assemblyStepRejection: { assemblyStepId: item.id } }
            : { componentOperationRejection: { componentOperationId: item.id } }),
        },
        data: { reworkStartedAt: now },
      });
    }
    // B9 / H3: server-stamped revision the part was cut to.
    if (starting && item.kind === "COMPONENT_OP" && item.opCode === "CUTTING" && row.currentRevisionId != null) {
      builtToRevisionId = row.currentRevisionId;
      await tx.component.update({ where: { id: row.componentId! }, data: { builtToRevisionId } });
    }
  }

  let sequenceOverride: Record<string, unknown> | null = null;
  if (overridden.length) {
    const prior = nearest(overridden);
    await tx.sequenceOverride.create({
      data: {
        jobId: ctx.job.id,
        targetKind: item.kind,
        targetId: item.id,
        unitId: row.unitId,
        category: ctx.override!.category,
        note: ctx.override!.note ?? null,
        predecessorTargetId: prior.id,
        createdBy: actor.userId,
      },
    });
    sequenceOverride = {
      category: ctx.override!.category,
      note: ctx.override!.note ?? null,
      predecessorTargetId: prior.id,
      open: overridden.map((o) => ({ kind: o.kind, id: o.id })),
    };
  }

  await recordAudit(tx, actor, {
    action: action === "START" ? "work.start" : "work.done",
    entityType: ENTITY[item.kind],
    entityId: item.id,
    before: { status: from },
    after: { ...written, builtToRevisionId, recordedAt: now, reportedAt, late, sequenceOverride, requestId: ctx.requestId ?? null },
    eventType: action === "START" ? "WorkStarted" : "WorkDone",
    eventPayload: { kind: item.kind, id: item.id, from, to, unitId: row.unitId },
  });

  if (fileLateOn) await fileLateReason(ctx, fileLateOn);

  // Later items in this batch see this one's new state.
  item.status = to;
  if (starting) row.startedAt = reportedAt ?? now;
  return { kind: item.kind, id: item.id, from, to, overridden: overridden.length > 0, late };
}

/** One DelayReason per late plan, notified to the Production Head as fileDelayReason does. */
async function fileLateReason(ctx: BatchContext, planRow: WorkRow): Promise<void> {
  const { tx, actor } = ctx;
  const { categoryId, note } = ctx.lateReason!;
  const reason = await tx.delayReason.create({
    data: { jobId: ctx.job.id, processPlanId: planRow.item.id, categoryId, detail: note ?? null, filedBy: actor.userId },
  });
  await recordAudit(tx, actor, {
    action: "delay.file",
    entityType: "DelayReason",
    entityId: reason.id,
    after: { processPlanId: planRow.item.id, categoryId, ownerDepartmentId: planRow.departmentId, via: "recordWork" },
    eventType: "DelayReasonFiled",
    eventPayload: { processPlanId: planRow.item.id, categoryId, ownerDepartmentId: planRow.departmentId },
  });
  // The row is shared through plansBySeq: later items of this batch see the reason.
  planRow.hasDelayReason = true;

  const heads = await userIdsWithRole(tx, actor.tenantId, ROLES.PRODUCTION_HEAD);
  if (heads.length) {
    const plan = await tx.processPlan.findUniqueOrThrow({ where: { id: planRow.item.id } });
    const n = await loadPlanNotifyContext(tx, plan);
    await notify(
      tx,
      actor.tenantId,
      heads.map((recipientId) => ({
        recipientId,
        type: "DELAY_FILED",
        entityType: "DelayReason",
        entityId: reason.id,
        title: `Delay filed: ${n.processName}${n.serialNo ? ` — Unit ${n.serialNo}` : ""}`,
        body: `filed by ${actor.name} · ${n.jobNumber}`,
        payload: { jobId: n.jobId, unitId: n.unitId, stageNo: n.stageNo },
      })),
    );
  }
}

/** Item submitted → QC, once per unit per batch (not once per item). */
async function notifyQc(
  tx: Tx,
  actor: Actor,
  job: { id: number; jobNumber: string },
  submitted: Map<number | null, Array<{ kind: WorkKind; id: number }>>,
): Promise<void> {
  if (submitted.size === 0) return;
  const qcIds = await userIdsWithRole(tx, actor.tenantId, ROLES.QC);
  if (qcIds.length === 0) return;
  const unitIds = [...submitted.keys()].filter((u): u is number => u != null);
  const serials = new Map(
    (await tx.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, serialNo: true } })).map((u) => [u.id, u.serialNo]),
  );
  await notify(
    tx,
    actor.tenantId,
    [...submitted.entries()].flatMap(([unitId, list]) =>
      qcIds.map((recipientId) => ({
        recipientId,
        type: "ITEM_SUBMITTED",
        entityType: unitId != null ? "Unit" : "Job",
        entityId: unitId ?? job.id,
        title: `${list.length} item${list.length === 1 ? "" : "s"} awaiting your verification${unitId != null ? ` — Unit ${serials.get(unitId)}` : ""}`,
        body: `Submitted by ${actor.name} · ${job.jobNumber}`,
        payload: { jobId: job.id, unitId, items: list },
      })),
    ),
  );
}

// ── inspect ──────────────────────────────────────────────────────────────

export interface InspectResult {
  kind: WorkKind;
  targetId: number;
  result: "ACCEPT" | "REJECT";
  from: string;
  to: string;
  rolledUp: RollupChange[];
}

/** The rejection category a QC reject files under: the given one, else the tenant's REWORK_QUALITY, else OTHER. */
async function rejectionCategoryId(tx: Tx, tenantId: number, categoryId?: number): Promise<number> {
  if (categoryId != null) {
    const c = await tx.delayCategoryRef.findFirst({ where: { id: categoryId, tenantId, active: true }, select: { id: true } });
    if (!c) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "DelayCategoryRef", categoryId });
    return c.id;
  }
  const defaults = await tx.delayCategoryRef.findMany({
    where: { tenantId, active: true, code: { in: ["REWORK_QUALITY", "OTHER"] } },
    select: { id: true, code: true },
  });
  const c = defaults.find((d) => d.code === "REWORK_QUALITY") ?? defaults[0];
  if (!c) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      { field: "categoryId" },
      "Choose a rejection category; none is set up as the default.",
    );
  }
  return c.id;
}

/**
 * Lean Core L1.2e: QC's one write — accept or reject an item. Wraps the
 * existing verify/reject bodies (maker–checker, hold-point and NCR handling,
 * QCP execution sync with its AUD-004 external-party guard) and then rolls up
 * the plan the item feeds, all in one transaction under the unit's floor lock.
 *
 * - ASSEMBLY_STEP: SUBMITTED, or an INSPECTION-kind step QC records directly.
 * - COMPONENT_OP: SUBMITTED only.
 * - PROCESS_PLAN: a SUBMITTED non-derived plan only (derived plans are never
 *   submitted: DERIVED_STATUS). // ponytail: delegates to verifyProcess /
 *   rejectProcess, which own a RepeatableRead transaction, so this path takes
 *   no unit lock; a non-derived plan has no mapped items for a batch to race.
 *
 * Not flag-gated (services are called directly by tests); the Server Action is.
 */
export async function inspect(actor: Actor, input: InspectInput): Promise<InspectResult> {
  const { kind, targetId, result, reason, categoryId, testTypeId } = inspectSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC);
  const done = (from: string, to: string, rolledUp: RollupChange[] = []): InspectResult => ({
    kind,
    targetId,
    result,
    from,
    to,
    rolledUp,
  });

  if (kind === "PROCESS_PLAN") {
    const plan = await withTenant(actor.tenantId, async (tx) => {
      const p = await lockProcessPlanForUpdate(tx, targetId, actor.tenantId);
      const mapped = await loadMappedOps(tx, { jobProcessId: p.jobProcessId, unitId: p.unitId, jobId: p.jobId });
      if (mapped.length > 0) throw new AppError(ERROR_CODES.DERIVED_STATUS, { processPlanId: p.id });
      return p;
    });
    const updated =
      result === "ACCEPT"
        ? await verifyProcess(actor, { processPlanId: targetId })
        : await rejectProcess(actor, { processPlanId: targetId, reason: reason! });
    return done(plan.status, updated.status);
  }

  const target = await withTenant(actor.tenantId, async (tx) =>
    kind === "ASSEMBLY_STEP"
      ? tx.assemblyStep.findFirst({
          where: { id: targetId, unit: { equipment: { job: { tenantId: actor.tenantId } } } },
          select: { jobId: true, unitId: true },
        })
      : tx.componentOperation
          .findFirst({
            where: { id: targetId, component: { equipment: { job: { tenantId: actor.tenantId } } } },
            select: { jobId: true, component: { select: { unitId: true } } },
          })
          .then((o) => (o ? { jobId: o.jobId, unitId: o.component.unitId } : null)),
  );
  if (!target) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: ENTITY[kind], id: targetId });

  return withJob(
    actor.tenantId,
    target.jobId,
    async (tx) => {
      await lockFloorUnits(tx, target.jobId, [target.unitId]);
      const category = result === "REJECT" ? await rejectionCategoryId(tx, actor.tenantId, categoryId) : 0;
      if (kind === "ASSEMBLY_STEP") {
        const r = await inspectAssemblyStepTx(tx, actor, { assemblyStepId: targetId, result, reason, categoryId: category, testTypeId });
        const change = await rollupForAssemblyStep(tx, actor, targetId);
        return done(r.from, r.step.status, change ? [change] : []);
      }
      const updated =
        result === "ACCEPT"
          ? await verifyComponentOperationTx(tx, actor, targetId)
          : await rejectComponentOperationTx(tx, actor, { componentOperationId: targetId, categoryId: category, detail: reason });
      const change = await rollupForComponentOperation(tx, actor, targetId);
      return done("SUBMITTED", updated.status, change ? [change] : []);
    },
    { timeoutMs: 30_000 },
  );
}
