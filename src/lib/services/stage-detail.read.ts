import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { workingDaysBetween } from "@/lib/schedule";
import { stageName } from "@/lib/shared/stage-names";
import { loadJobSpine, loadMappedOps, type MappedOp } from "./_shared";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { ProcessPlanStatus } from "@/generated/prisma/client";

/**
 * Full per-(unit, stage) detail behind the real `StageSheet` (§4.5) — backs
 * `GET /api/jobs/:id/stage?unit=&stage=`. Reuses the canonical
 * `v_unit_stage_status` view for the fill/overdue/rejected/governing-plan
 * verdict (never re-implements the §11.2 ladder) and adds everything the
 * sheet needs beyond that verdict: the stage-level target/actual dates and
 * variance (§11.4), the multi-process backing checklist, linked hold points,
 * delay-reason history, and rejection history — each attributed to its real
 * backing ProcessPlan, per the spec's "always attributed to a process" rule.
 */
export interface StageBackingPlan {
  planId: number;
  jobProcessId: number;
  processName: string;
  status: ProcessPlanStatus;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  standardDays: number | null;
  submittedByName: string | null;
  isGoverning: boolean;
  /** Fabrication/assembly operations rolling up into this process on this unit (Phase 3, R4). Empty when nothing is mapped. */
  contributingOps: MappedOp[];
}

export interface StageHoldPoint {
  qcpItemId: number;
  srNo: string;
  activity: string;
  classCode: string;
  status: string; // Cleared | Awaiting TPI | Pending | QC review | Reinspect
  ageDays: number;
}

export interface StageDelayReason {
  id: number;
  processPlanId: number;
  category: string;
  detail: string | null;
  filedByName: string;
  filedAt: string;
}

export interface StageRejection {
  at: string;
  reason: string | null;
  actorName: string | null;
  processName: string;
}

export interface StageDetail {
  jobId: number;
  jobNumber: string;
  stageNo: number;
  stageName: string;
  unitId: number;
  serialNo: string;
  deptName: string;
  status: StageDisplayStatus;
  overduePip: boolean;
  rejectedMarker: boolean;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  /** (actualFinish ?? now) − plannedFinish, calendar days. Positive = late. */
  varianceDays: number | null;
  /** Sum of the backing processes' standard (max) duration, working days. */
  standardDays: number | null;
  /** Working days from actualStart to (actualFinish ?? now). */
  elapsedDays: number | null;
  governingPlanId: number | null;
  backingPlans: StageBackingPlan[];
  holdPoints: StageHoldPoint[];
  delayReasons: StageDelayReason[];
  rejections: StageRejection[];
  delayCategories: { id: number; name: string }[];
}

interface ViewRow {
  fill_status: StageDisplayStatus;
  is_overdue: boolean;
  is_rejected: boolean;
  governing_plan_id: number | null;
}

export async function loadStageDetail(
  actor: Actor,
  jobId: number,
  unitId: number,
  stageNo: number,
): Promise<StageDetail | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true, jobNumber: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const unit = await tx.unit.findFirst({ where: { id: unitId, equipment: { jobId } }, select: { serialNo: true } });
    if (!unit) return null;

    const viewRows = await tx.$queryRaw<ViewRow[]>`
      SELECT fill_status, is_overdue, is_rejected, governing_plan_id
      FROM v_unit_stage_status
      WHERE job_id = ${jobId} AND unit_id = ${unitId} AND stage_no = ${stageNo}
    `;
    const view = viewRows[0];
    if (!view) return null;

    const backingProcesses = await tx.jobProcess.findMany({
      where: { jobId, workOrderStages: { has: stageNo } },
      orderBy: { seq: "asc" },
      select: {
        id: true,
        name: true,
        durationMaxDays: true,
        department: { select: { name: true } },
      },
    });
    const jpIds = backingProcesses.map((p) => p.id);

    const run = await tx.scheduleRun.findFirst({ where: { jobId, equipmentId: null, isCurrent: true }, select: { id: true } });
    const plans = run
      ? await tx.processPlan.findMany({
          where: { scheduleRunId: run.id, jobProcessId: { in: jpIds }, unitId },
          select: {
            id: true,
            jobProcessId: true,
            status: true,
            plannedStart: true,
            plannedFinish: true,
            actualStart: true,
            actualFinish: true,
            submittedBy: true,
          },
        })
      : [];

    const submitterIds = [...new Set(plans.map((p) => p.submittedBy).filter((x): x is number => x != null))];
    const submitters = submitterIds.length
      ? await tx.user.findMany({ where: { id: { in: submitterIds } }, select: { id: true, name: true } })
      : [];
    const nameBySubmitter = new Map(submitters.map((u) => [u.id, u.name]));

    const planByProcess = new Map(plans.map((p) => [p.jobProcessId, p]));
    const backingPlans: StageBackingPlan[] = await Promise.all(
      backingProcesses
        .filter((p) => planByProcess.has(p.id))
        .map(async (p) => {
          const plan = planByProcess.get(p.id)!;
          return {
            planId: plan.id,
            jobProcessId: p.id,
            processName: p.name,
            status: plan.status,
            plannedStart: plan.plannedStart?.toISOString() ?? null,
            plannedFinish: plan.plannedFinish?.toISOString() ?? null,
            actualStart: plan.actualStart?.toISOString() ?? null,
            actualFinish: plan.actualFinish?.toISOString() ?? null,
            standardDays: p.durationMaxDays,
            submittedByName: plan.submittedBy != null ? (nameBySubmitter.get(plan.submittedBy) ?? null) : null,
            isGoverning: plan.id === view.governing_plan_id,
            contributingOps: await loadMappedOps(tx, { jobProcessId: p.id, unitId }),
          };
        }),
    );

    // §11.4 stage-level dates, rolled up from the backing plans.
    const toDate = (s: string | null) => (s ? new Date(s) : null);
    const starts = backingPlans.map((p) => toDate(p.plannedStart)).filter((d): d is Date => d != null);
    const finishes = backingPlans.map((p) => toDate(p.plannedFinish)).filter((d): d is Date => d != null);
    const actualStarts = backingPlans.map((p) => toDate(p.actualStart)).filter((d): d is Date => d != null);
    const allComplete = backingPlans.length > 0 && backingPlans.every((p) => p.status === "COMPLETE");
    const actualFinishes = allComplete
      ? backingPlans.map((p) => toDate(p.actualFinish)).filter((d): d is Date => d != null)
      : [];

    const plannedStart = starts.length ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null;
    const plannedFinish = finishes.length ? new Date(Math.max(...finishes.map((d) => d.getTime()))) : null;
    const actualStart = actualStarts.length ? new Date(Math.min(...actualStarts.map((d) => d.getTime()))) : null;
    const actualFinish = actualFinishes.length ? new Date(Math.max(...actualFinishes.map((d) => d.getTime()))) : null;

    const now = new Date();
    const varianceDays = plannedFinish ? Math.round(((actualFinish ?? now).getTime() - plannedFinish.getTime()) / 864e5) : null;

    const spine = await loadJobSpine(tx, jobId);
    const standardDays = jpIds.length
      ? jpIds.reduce((sum, id) => sum + (spine.rawProcesses.find((rp) => rp.id === id)?.durationMaxDays ?? 0), 0)
      : null;
    const elapsedDays = actualStart ? workingDaysBetween(actualStart, actualFinish ?? now, spine.calendar) : null;

    // ── Hold points linked to this stage's backing processes, for this unit ──
    const qcpItems = jpIds.length
      ? await tx.qcpItem.findMany({
          where: { processLinks: { some: { jobProcessId: { in: jpIds } } } },
          select: {
            id: true,
            srNo: true,
            activity: true,
            partyCodes: { select: { qcpCode: { select: { code: true, requiresCall: true, blocksCompletion: true } } } },
          },
        })
      : [];
    const itemIds = qcpItems.map((i) => i.id);
    const execs = itemIds.length
      ? await tx.qcpExecution.findMany({
          where: { unitId, qcpItemId: { in: itemIds } },
          orderBy: { attemptNo: "desc" },
          select: { qcpItemId: true, result: true, recordedAt: true },
        })
      : [];
    const latestByItem = new Map<number, { result: string; recordedAt: Date }>();
    for (const e of execs) if (!latestByItem.has(e.qcpItemId)) latestByItem.set(e.qcpItemId, { result: e.result, recordedAt: e.recordedAt });

    const holdPoints: StageHoldPoint[] = qcpItems.map((item) => {
      const blocking = item.partyCodes.find((pc) => pc.qcpCode.blocksCompletion) ?? item.partyCodes[0];
      const classCode = blocking?.qcpCode.code ?? "?";
      const requiresCall = blocking?.qcpCode.requiresCall ?? false;
      const attempt = latestByItem.get(item.id);
      let status: string;
      let ageRef: Date | null;
      if (!attempt) {
        status = requiresCall ? "Awaiting TPI" : "Pending";
        ageRef = plannedStart;
      } else if (attempt.result === "ACCEPTED" || attempt.result === "NA") {
        status = "Cleared";
        ageRef = null;
      } else if (attempt.result === "REJECTED") {
        status = "Reinspect";
        ageRef = attempt.recordedAt;
      } else {
        status = "QC review";
        ageRef = attempt.recordedAt;
      }
      const ageDays = ageRef ? Math.max(0, Math.floor((now.getTime() - ageRef.getTime()) / 864e5)) : 0;
      return { qcpItemId: item.id, srNo: item.srNo, activity: item.activity, classCode, status, ageDays };
    });

    // ── Delay-reason history, attributed to a backing plan ───────────────────
    const planIds = backingPlans.map((p) => p.planId);
    const delayRows = planIds.length
      ? await tx.delayReason.findMany({
          where: { processPlanId: { in: planIds } },
          orderBy: { filedAt: "desc" },
          select: { id: true, processPlanId: true, detail: true, filedAt: true, filedBy: true, category: { select: { name: true } } },
        })
      : [];
    const filerIds = [...new Set(delayRows.map((d) => d.filedBy))];
    const filers = filerIds.length ? await tx.user.findMany({ where: { id: { in: filerIds } }, select: { id: true, name: true } }) : [];
    const nameByFiler = new Map(filers.map((u) => [u.id, u.name]));
    const delayReasons: StageDelayReason[] = delayRows.map((d) => ({
      id: d.id,
      processPlanId: d.processPlanId,
      category: d.category.name,
      detail: d.detail,
      filedByName: nameByFiler.get(d.filedBy) ?? "—",
      filedAt: d.filedAt.toISOString(),
    }));

    // ── Rejection history — the §11.2 "rejected" marker's full detail ───────
    const rejectionRows = planIds.length
      ? await tx.$queryRaw<{ at: Date; payload: { reason?: string }; actor_name: string | null; process_name: string }[]>`
          SELECT de.at, de.payload, u.name AS actor_name, jp.name AS process_name
          FROM domain_events de
          JOIN process_plans pp ON pp.id = de.aggregate_id::int
          JOIN job_processes jp ON jp.id = pp.job_process_id
          LEFT JOIN users u ON u.id = de.actor_id
          WHERE de.aggregate_type = 'ProcessPlan' AND de.type = 'ProcessRejected'
            AND de.aggregate_id::int = ANY(${planIds}::int[])
          ORDER BY de.at DESC
        `
      : [];
    const rejections: StageRejection[] = rejectionRows.map((r) => ({
      at: r.at.toISOString(),
      reason: r.payload?.reason ?? null,
      actorName: r.actor_name,
      processName: r.process_name,
    }));

    const governingProcess =
      backingProcesses.find((p) => planByProcess.get(p.id)?.id === view.governing_plan_id) ?? backingProcesses[0];

    const delayCategories = await tx.delayCategoryRef.findMany({ where: { active: true }, select: { id: true, name: true } });

    return {
      jobId,
      jobNumber: job.jobNumber,
      stageNo,
      stageName: stageName(stageNo),
      unitId,
      serialNo: unit.serialNo,
      deptName: governingProcess?.department.name ?? "—",
      status: view.fill_status,
      overduePip: view.is_overdue && view.fill_status !== "overdue",
      rejectedMarker: view.is_rejected,
      plannedStart: plannedStart ? plannedStart.toISOString() : null,
      plannedFinish: plannedFinish ? plannedFinish.toISOString() : null,
      actualStart: actualStart ? actualStart.toISOString() : null,
      actualFinish: actualFinish ? actualFinish.toISOString() : null,
      varianceDays,
      standardDays,
      elapsedDays,
      governingPlanId: view.governing_plan_id,
      backingPlans,
      holdPoints,
      delayReasons,
      rejections,
      delayCategories,
    };
  });
}
