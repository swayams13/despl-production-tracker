import { withTenant } from "@/lib/db";
import { assertClientScope, assertNotClientUser, type Actor } from "@/lib/authz";
import { fmtLongDay, planStatusWord } from "@/lib/shared/board";

/**
 * Lean Core L2.4: the rows of the "Units x Process Tracker" sheet in
 * docs/DESPL-320 Production Tracker.xlsx: one row per process, one column per
 * unit, the workbook's own status words. Start by / Finish by are the
 * earliest planned start and latest planned finish across the units.
 */
export interface TrackerSheet {
  jobNumber: string;
  title: string;
  serials: string[];
  rows: Array<{ seq: number; name: string; department: string; startBy: string; finishBy: string; cells: string[] }>;
}

export async function loadTrackerSheet(actor: Actor, jobId: number): Promise<TrackerSheet | null> {
  assertNotClientUser(actor);
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: jobId },
      select: { clientId: true, jobNumber: true, projectName: true },
    });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const [units, processes, run] = await Promise.all([
      tx.unit.findMany({ where: { jobId }, orderBy: { serialNo: "asc" }, select: { id: true, serialNo: true } }),
      tx.jobProcess.findMany({
        where: { jobId },
        orderBy: { seq: "asc" },
        select: { id: true, seq: true, name: true, included: true, department: { select: { name: true } } },
      }),
      tx.scheduleRun.findFirst({ where: { jobId, equipmentId: null, isCurrent: true }, select: { id: true } }),
    ]);
    const plans = run
      ? await tx.processPlan.findMany({
          where: { scheduleRunId: run.id },
          select: { jobProcessId: true, unitId: true, status: true, verifiedBy: true, plannedStart: true, plannedFinish: true },
        })
      : [];
    const byKey = new Map(plans.map((p) => [`${p.jobProcessId}:${p.unitId ?? "job"}`, p]));
    const plansOf = new Map<number, typeof plans>();
    for (const p of plans) plansOf.set(p.jobProcessId, [...(plansOf.get(p.jobProcessId) ?? []), p]);

    return {
      jobNumber: job.jobNumber,
      title: job.projectName ?? job.jobNumber,
      serials: units.map((u) => u.serialNo),
      rows: processes.map((p) => {
        const mine = plansOf.get(p.id) ?? [];
        const starts = mine.map((x) => x.plannedStart?.getTime()).filter((n): n is number => n != null);
        const finishes = mine.map((x) => x.plannedFinish?.getTime()).filter((n): n is number => n != null);
        return {
          seq: p.seq,
          name: p.name,
          department: p.department.name,
          startBy: starts.length ? fmtLongDay(new Date(Math.min(...starts)).toISOString()) : "",
          finishBy: finishes.length ? fmtLongDay(new Date(Math.max(...finishes)).toISOString()) : "",
          cells: units.map((u) => {
            if (!p.included) return "-";
            const plan = byKey.get(`${p.id}:${u.id}`) ?? byKey.get(`${p.id}:job`);
            return plan ? planStatusWord(plan.status, plan.verifiedBy != null) : "-";
          }),
        };
      }),
    };
  });
}
