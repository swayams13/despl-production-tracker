import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";

/**
 * `/qc` — cross-job QC cockpit (§4.8): the QC user's home surface. Everything
 * here reads across every job in the tenant (RLS scopes the tenant boundary;
 * there is no job filter) — the first genuinely cross-job aggregate in the
 * app, everything before this session was job-scoped (`loadJobKpis`,
 * `loadWorkspaceView`, `loadOpenHoldPoints` all take a required `jobId`).
 */
export interface QcQueueRow {
  planId: number;
  jobId: number;
  jobNumber: string;
  unitId: number;
  serialNo: string;
  stageNo: number;
  processName: string;
  deptName: string;
  submittedByName: string | null;
  submittedAt: string | null;
}

export interface GlobalHoldPoint {
  qcpItemId: number;
  jobId: number;
  jobNumber: string;
  unitId: number;
  serialNo: string;
  stageNo: number;
  srNo: string;
  activity: string;
  classCode: string;
  awaitingTpi: boolean;
  status: string;
  ageDays: number;
}

/** One point on the 6-week first-pass-yield trend — same metric definition as `loadJobKpis`' `firstPassYieldPct` (submitted-ever minus rejected-ever, over submitted-ever), bucketed weekly instead of job-lifetime-to-date. */
export interface WeeklyYield {
  weekStart: string;
  submitted: number;
  rejected: number;
  yieldPct: number | null;
}

export interface RejectByCheckpoint {
  activity: string;
  count: number;
}

/** N4 — rework load, tenant-wide. `openCount` covers every non-CLOSED Ncr (OPEN + DISPOSITIONED + REWORK_IN_PROGRESS); `totalReworkHours` sums reworkFinishedAt - reworkStartedAt for CLOSED NCRs whose disposition needed floor rework. */
export interface ReworkSummary {
  openCount: number;
  totalReworkHours: number;
}

/**
 * S11 — one row per Ncr still in OPEN status, i.e. rejected but never
 * dispositioned (`dispositionNcr` is the only legal transition out of OPEN;
 * REWORK_IN_PROGRESS/DISPOSITIONED/CLOSED are all past that decision, so they
 * don't belong in an actionable list).
 */
export interface OpenNcrRow {
  ncrId: number;
  jobId: number;
  jobNumber: string;
  unitId: number | null;
  serialNo: string | null;
  entityLabel: string;
  categoryName: string;
  rejectionDetail: string | null;
  rejectedByName: string;
  rejectedAt: string;
}

export interface QcCockpit {
  queue: QcQueueRow[];
  holdPoints: GlobalHoldPoint[];
  yieldTrend: WeeklyYield[];
  rejectsByCheckpoint: RejectByCheckpoint[];
  rework: ReworkSummary;
  openNcrs: OpenNcrRow[];
}

interface QueueRow {
  plan_id: number;
  job_id: number;
  job_number: string;
  unit_id: number;
  serial_no: string;
  stage_no: number;
  process_name: string;
  dept_name: string;
  submitted_by_name: string | null;
  submitted_at: Date | null;
}

export async function loadQcCockpit(actor: Actor): Promise<QcCockpit> {
  return withTenant(actor.tenantId, async (tx) => {
    // ── Awaiting verification queue, oldest submission first ────────────────
    const queueRows = await tx.$queryRaw<QueueRow[]>`
      SELECT pp.id AS plan_id, j.id AS job_id, j.job_number, u.id AS unit_id, u.serial_no,
             jp.work_order_stages[1] AS stage_no, jp.name AS process_name, d.name AS dept_name,
             usr.name AS submitted_by_name,
             (SELECT max(de.at) FROM domain_events de WHERE de.aggregate_type = 'ProcessPlan' AND de.aggregate_id = pp.id::text AND de.type = 'ProcessSubmitted') AS submitted_at
      FROM process_plans pp
      JOIN job_processes jp ON jp.id = pp.job_process_id
      JOIN jobs j ON j.id = jp.job_id
      JOIN units u ON u.id = pp.unit_id
      JOIN departments d ON d.id = pp.owner_department_id
      JOIN schedule_runs sr ON sr.id = pp.schedule_run_id
      LEFT JOIN users usr ON usr.id = pp.submitted_by
      WHERE pp.status = 'SUBMITTED' AND sr.is_current = true
      ORDER BY submitted_at ASC NULLS LAST
    `;
    const queue: QcQueueRow[] = queueRows.map((r) => ({
      planId: r.plan_id,
      jobId: r.job_id,
      jobNumber: r.job_number,
      unitId: r.unit_id,
      serialNo: r.serial_no,
      stageNo: r.stage_no ?? 0,
      processName: r.process_name,
      deptName: r.dept_name,
      submittedByName: r.submitted_by_name,
      submittedAt: r.submitted_at ? r.submitted_at.toISOString() : null,
    }));

    // ── Open hold points, cross-job (same blocking/latest-attempt logic as
    //    loadOpenHoldPoints in workspace.read.ts, generalised off one job) ────
    const blockingItems = await tx.qcpItem.findMany({
      where: { partyCodes: { some: { qcpCode: { blocksCompletion: true } } } },
      select: {
        id: true,
        srNo: true,
        activity: true,
        partyCodes: { where: { qcpCode: { blocksCompletion: true } }, select: { qcpCode: { select: { code: true, requiresCall: true } } } },
        processLinks: {
          select: { jobProcess: { select: { id: true, seq: true, workOrderStages: true, job: { select: { id: true, jobNumber: true } } } } },
          orderBy: { jobProcess: { seq: "asc" } },
          take: 1,
        },
      },
    });

    const holdPoints: GlobalHoldPoint[] = [];
    if (blockingItems.length > 0) {
      const itemIds = blockingItems.map((i) => i.id);
      const execs = await tx.qcpExecution.findMany({
        where: { qcpItemId: { in: itemIds } },
        orderBy: { attemptNo: "desc" },
        select: { qcpItemId: true, unitId: true, result: true, recordedAt: true },
      });
      const latestByKey = new Map<string, { result: string; recordedAt: Date }>();
      for (const e of execs) {
        const k = `${e.qcpItemId}:${e.unitId}`;
        if (!latestByKey.has(k)) latestByKey.set(k, { result: e.result, recordedAt: e.recordedAt });
      }

      const linkedJp = new Map(blockingItems.map((i) => [i.id, i.processLinks[0]?.jobProcess]));
      const jpIds = [...linkedJp.values()].filter((jp): jp is NonNullable<typeof jp> => jp != null).map((jp) => jp.id);
      const plans = jpIds.length
        ? await tx.processPlan.findMany({
            where: { jobProcessId: { in: jpIds }, scheduleRun: { isCurrent: true }, unitId: { not: null } },
            select: { jobProcessId: true, unitId: true, plannedStart: true, unit: { select: { serialNo: true } } },
          })
        : [];
      const now = new Date();

      for (const item of blockingItems) {
        const jp = linkedJp.get(item.id);
        if (!jp) continue;
        const blockingCode = item.partyCodes[0]?.qcpCode;
        const classCode = blockingCode?.code ?? "?";
        const requiresCall = blockingCode?.requiresCall ?? false;
        const unitPlans = plans.filter((p) => p.jobProcessId === jp.id);

        for (const p of unitPlans) {
          if (p.unitId == null) continue;
          const attempt = latestByKey.get(`${item.id}:${p.unitId}`);
          const r = attempt?.result;
          if (r === "ACCEPTED" || r === "NA") continue; // cleared

          let status: string;
          let ageRef: Date | null;
          if (!attempt) {
            status = requiresCall ? "Awaiting TPI" : "Pending";
            ageRef = p.plannedStart;
          } else if (r === "REJECTED") {
            status = "Reinspect";
            ageRef = attempt.recordedAt;
          } else {
            status = "QC review";
            ageRef = attempt.recordedAt;
          }
          const ageDays = ageRef ? Math.max(0, Math.floor((now.getTime() - ageRef.getTime()) / 864e5)) : 0;

          holdPoints.push({
            qcpItemId: item.id,
            jobId: jp.job.id,
            jobNumber: jp.job.jobNumber,
            unitId: p.unitId,
            serialNo: p.unit!.serialNo,
            stageNo: jp.workOrderStages[0] ?? 0,
            srNo: item.srNo,
            activity: item.activity,
            classCode,
            awaitingTpi: status === "Awaiting TPI",
            status,
            ageDays,
          });
        }
      }
    }

    // ── 6-week first-pass-yield trend ────────────────────────────────────────
    const weeklyRows = await tx.$queryRaw<{ week_start: Date; submitted: number; rejected: number }[]>`
      WITH weeks AS (
        SELECT date_trunc('week', now())::date - (n * 7) AS week_start
        FROM generate_series(5, 0, -1) AS n
      )
      SELECT w.week_start,
             count(*) FILTER (WHERE de.type = 'ProcessSubmitted')::int AS submitted,
             count(*) FILTER (WHERE de.type = 'ProcessRejected')::int AS rejected
      FROM weeks w
      LEFT JOIN domain_events de
        ON de.aggregate_type = 'ProcessPlan'
        AND date_trunc('week', de.at)::date = w.week_start
        AND de.type IN ('ProcessSubmitted', 'ProcessRejected')
      GROUP BY w.week_start
      ORDER BY w.week_start
    `;
    const yieldTrend: WeeklyYield[] = weeklyRows.map((w) => ({
      weekStart: w.week_start.toISOString(),
      submitted: w.submitted,
      rejected: w.rejected,
      yieldPct: w.submitted > 0 ? Math.round(((w.submitted - w.rejected) / w.submitted) * 100) : null,
    }));

    // ── Rejects by checkpoint activity (real categorical proxy — see progress.md:
    //    neither ProcessRejected nor QcpExecution carries a categorized reason,
    //    only free text, so "by reason" is approximated as "by which checkpoint") ─
    const rejectRows = await tx.qcpExecution.groupBy({
      by: ["qcpItemId"],
      where: { result: "REJECTED" },
      _count: { qcpItemId: true },
    });
    const rejectsByCheckpoint: RejectByCheckpoint[] = [];
    if (rejectRows.length > 0) {
      const items = await tx.qcpItem.findMany({ where: { id: { in: rejectRows.map((r) => r.qcpItemId) } }, select: { id: true, activity: true } });
      const activityById = new Map(items.map((i) => [i.id, i.activity]));
      for (const r of rejectRows) {
        rejectsByCheckpoint.push({ activity: activityById.get(r.qcpItemId) ?? "—", count: r._count.qcpItemId });
      }
      rejectsByCheckpoint.sort((a, b) => b.count - a.count);
    }

    // ── N4: rework load — Ncr carries no tenantId of its own (same reason
    //    qcp.service.ts anchors through unit.equipment.job), so both counts
    //    are reached via the rejection → operation/step → component/unit →
    //    equipment → job → tenantId chain, never RLS alone (audit C3).
    const tenantNcrScope = {
      OR: [
        { componentOperationRejection: { componentOperation: { component: { equipment: { job: { tenantId: actor.tenantId } } } } } },
        { assemblyStepRejection: { assemblyStep: { unit: { equipment: { job: { tenantId: actor.tenantId } } } } } },
      ],
    };
    const openCount = await tx.ncr.count({ where: { status: { not: "CLOSED" }, ...tenantNcrScope } });
    const closedReworkNcrs = await tx.ncr.findMany({
      where: {
        status: "CLOSED",
        disposition: { in: ["REPAIR", "REWORK"] },
        reworkStartedAt: { not: null },
        reworkFinishedAt: { not: null },
        ...tenantNcrScope,
      },
      select: { reworkStartedAt: true, reworkFinishedAt: true },
    });
    const totalReworkHours =
      Math.round(
        (closedReworkNcrs.reduce(
          (sum, n) => sum + (n.reworkFinishedAt!.getTime() - n.reworkStartedAt!.getTime()),
          0,
        ) /
          36e5) *
          10,
      ) / 10;

    // ── S11: OPEN Ncrs, i.e. rejected and awaiting a QC disposition ─────────
    const openNcrRows = await tx.ncr.findMany({
      where: { status: "OPEN", ...tenantNcrScope },
      orderBy: { id: "asc" },
      select: {
        id: true,
        dispositionNotes: true,
        componentOperationRejection: {
          select: {
            detail: true,
            rejectedAt: true,
            rejector: { select: { name: true } },
            category: { select: { name: true } },
            componentOperation: {
              select: {
                component: { select: { tag: true, unitId: true, unit: { select: { serialNo: true } }, equipment: { select: { jobId: true, job: { select: { jobNumber: true } } } } } },
                operation: { select: { name: true } },
              },
            },
          },
        },
        assemblyStepRejection: {
          select: {
            detail: true,
            rejectedAt: true,
            rejector: { select: { name: true } },
            category: { select: { name: true } },
            assemblyStep: {
              select: {
                templateStep: { select: { activity: true } },
                unit: { select: { id: true, serialNo: true, equipment: { select: { jobId: true, job: { select: { jobNumber: true } } } } } },
              },
            },
          },
        },
      },
    });
    const openNcrs: OpenNcrRow[] = openNcrRows.map((n) => {
      const cor = n.componentOperationRejection;
      const asr = n.assemblyStepRejection;
      if (cor) {
        const c = cor.componentOperation.component;
        return {
          ncrId: n.id,
          jobId: c.equipment.jobId,
          jobNumber: c.equipment.job.jobNumber,
          unitId: c.unitId,
          serialNo: c.unit?.serialNo ?? null,
          entityLabel: `${c.tag} · ${cor.componentOperation.operation.name}`,
          categoryName: cor.category.name,
          rejectionDetail: cor.detail,
          rejectedByName: cor.rejector.name,
          rejectedAt: cor.rejectedAt.toISOString(),
        };
      }
      const step = asr!.assemblyStep;
      return {
        ncrId: n.id,
        jobId: step.unit.equipment.jobId,
        jobNumber: step.unit.equipment.job.jobNumber,
        unitId: step.unit.id,
        serialNo: step.unit.serialNo,
        entityLabel: step.templateStep.activity,
        categoryName: asr!.category.name,
        rejectionDetail: asr!.detail,
        rejectedByName: asr!.rejector.name,
        rejectedAt: asr!.rejectedAt.toISOString(),
      };
    });

    return {
      queue,
      holdPoints,
      yieldTrend,
      rejectsByCheckpoint: rejectsByCheckpoint.slice(0, 8),
      rework: { openCount, totalReworkHours },
      openNcrs,
    };
  });
}
