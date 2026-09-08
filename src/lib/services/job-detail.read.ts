import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { getCurrentScheduleRun } from "./_shared";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import { isOverdue } from "@/lib/shared/business-day";

/**
 * Job detail header (§4.3): code, description, status chip, due + forecast
 * variance — the same forecast/percent-complete math `loadJobKpis` (dashboard)
 * runs, kept as its own small query rather than calling the dashboard's much
 * heavier aggregate (S-curve, throughput, cycle-time offenders, …) just for a
 * page header.
 */
export interface JobHeader {
  jobId: number;
  jobNumber: string;
  projectName: string | null;
  clientOrderNo: string | null;
  poRef: string | null;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  remarks: string | null;
  familyName: string;
  designCode: string | null;
  equipmentName: string | null;
  unitCount: number;
  orderDate: string | null;
  committedDeliveryDate: string | null;
  targetDispatchDate: string | null;
  forecastDispatch: string | null;
  forecastVarianceDays: number | null;
  totalPlans: number;
  completePlans: number;
  overduePlans: number;
  percentComplete: number;
  /** Overall job status chip — same collapse family as §11.2, applied across the whole plan set. */
  displayStatus: StageDisplayStatus;
}

export async function loadJobHeader(actor: Actor, jobId: number): Promise<JobHeader | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: jobId },
      select: {
        clientId: true,
        jobNumber: true,
        projectName: true,
        clientOrderNo: true,
        poRef: true,
        priority: true,
        remarks: true,
        designCode: true,
        orderDate: true,
        committedDeliveryDate: true,
        targetDispatchDate: true,
        family: { select: { name: true } },
        equipments: { select: { name: true, _count: { select: { units: true } } }, orderBy: { id: "asc" } },
      },
    });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const run = await getCurrentScheduleRun(tx, jobId);
    const plans = run?.processPlans ?? [];
    const totalPlans = plans.length;
    const completePlans = plans.filter((p) => p.status === "COMPLETE").length;
    const overduePlans = plans.filter((p) => p.status !== "COMPLETE" && isOverdue(p.plannedFinish)).length;
    // Phase 3, R1/R3: same duration-weighted, mapped-ops-aware view every
    // percent-complete surface reads — never re-derived from completePlans.
    const planIds = plans.map((p) => p.id);
    const percentRows = planIds.length
      ? await tx.$queryRaw<{ percent: string | number }[]>`
          SELECT sum(percent * weight) / sum(weight) AS percent
          FROM v_process_plan_percent
          WHERE process_plan_id = ANY(${planIds}::int[])
        `
      : [];
    const percentComplete = Math.round(Number(percentRows[0]?.percent ?? 0));

    const onHold = plans.some((p) => p.status === "ON_HOLD");
    const submitted = plans.some((p) => p.status === "SUBMITTED");
    const inProgress = plans.some((p) => p.status === "IN_PROGRESS");
    let displayStatus: StageDisplayStatus;
    if (totalPlans > 0 && completePlans === totalPlans) displayStatus = "complete";
    else if (onHold) displayStatus = "hold";
    else if (overduePlans > 0) displayStatus = "overdue";
    else if (submitted) displayStatus = "submitted";
    else if (inProgress || completePlans > 0) displayStatus = "progress";
    else displayStatus = "idle";

    const finishDates = plans.map((p) => p.plannedFinish).filter((d): d is Date => d != null);
    const forecastDispatch = finishDates.length ? new Date(Math.max(...finishDates.map((d) => d.getTime()))) : null;
    const forecastVarianceDays =
      forecastDispatch && job.committedDeliveryDate
        ? Math.round((forecastDispatch.getTime() - job.committedDeliveryDate.getTime()) / 864e5)
        : null;

    return {
      jobId,
      jobNumber: job.jobNumber,
      projectName: job.projectName,
      clientOrderNo: job.clientOrderNo,
      poRef: job.poRef,
      priority: job.priority,
      remarks: job.remarks,
      familyName: job.family.name,
      designCode: job.designCode,
      equipmentName: job.equipments[0]?.name ?? null,
      unitCount: job.equipments.reduce((n, e) => n + e._count.units, 0),
      orderDate: job.orderDate ? job.orderDate.toISOString() : null,
      committedDeliveryDate: job.committedDeliveryDate ? job.committedDeliveryDate.toISOString() : null,
      targetDispatchDate: job.targetDispatchDate ? job.targetDispatchDate.toISOString() : null,
      forecastDispatch: forecastDispatch ? forecastDispatch.toISOString() : null,
      forecastVarianceDays,
      totalPlans,
      completePlans,
      overduePlans,
      percentComplete,
      displayStatus,
    };
  });
}
