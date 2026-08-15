import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { getCurrentScheduleRun } from "./_shared";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";

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
  familyName: string;
  designCode: string | null;
  equipmentName: string | null;
  unitCount: number;
  deliveryDate: string | null;
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
        designCode: true,
        deliveryDate: true,
        family: { select: { name: true } },
        equipments: { select: { name: true, _count: { select: { units: true } } }, orderBy: { id: "asc" } },
      },
    });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const run = await getCurrentScheduleRun(tx, jobId, null);
    const plans = run?.processPlans ?? [];
    const totalPlans = plans.length;
    const completePlans = plans.filter((p) => p.status === "COMPLETE").length;
    const now = new Date();
    const overduePlans = plans.filter((p) => p.status !== "COMPLETE" && p.plannedFinish != null && p.plannedFinish < now).length;
    const percentComplete = totalPlans > 0 ? Math.round((completePlans / totalPlans) * 100) : 0;

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
      forecastDispatch && job.deliveryDate
        ? Math.round((forecastDispatch.getTime() - job.deliveryDate.getTime()) / 864e5)
        : null;

    return {
      jobId,
      jobNumber: job.jobNumber,
      projectName: job.projectName,
      familyName: job.family.name,
      designCode: job.designCode,
      equipmentName: job.equipments[0]?.name ?? null,
      unitCount: job.equipments.reduce((n, e) => n + e._count.units, 0),
      deliveryDate: job.deliveryDate ? job.deliveryDate.toISOString() : null,
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
