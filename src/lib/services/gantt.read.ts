import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { getCurrentScheduleRun } from "./_shared";
import type { GanttBar, GanttUnit, JobGanttData } from "./gantt-layout";
import { isOverdue } from "@/lib/shared/business-day";

export type { GanttBar, GanttEdge, GanttUnit, JobGanttData, GanttDomain, DepartmentDeadline } from "./gantt-layout";
export { planFillStatus, computeGanttDomain, computeDepartmentDeadlines, ganttPct } from "./gantt-layout";

/**
 * Job detail — Timeline (Gantt) tab (§4.3, §9.6). One row per JobProcess
 * (36-grain, not the 25-stage rollup — the Gantt is process-level per the
 * spec's "finish-to-start dependencies" requirement, which only exists at
 * that grain). Loads every unit's bars in one query (bounded: max ~40 units ×
 * 36 processes for the pilot family) so the client can switch the expanded
 * unit group with no extra fetch, matching the "collapsible per-unit groups"
 * spec without a round-trip per click.
 */
export async function loadJobGantt(actor: Actor, jobId: number): Promise<JobGanttData | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const units = await tx.unit.findMany({
      where: { equipment: { jobId } },
      select: { id: true, serialNo: true },
      orderBy: { serialNo: "asc" },
    });
    const now = new Date();
    if (units.length === 0) return { units: [], edges: [], now: now.toISOString() };

    const run = await getCurrentScheduleRun(tx, jobId, null);
    if (!run) return { units: [], edges: [], now: now.toISOString() };

    const processes = await tx.jobProcess.findMany({
      where: { jobId },
      orderBy: { seq: "asc" },
      select: { id: true, code: true, name: true, seq: true, workOrderStages: true, durationMaxDays: true, department: { select: { name: true } } },
    });
    const processById = new Map(processes.map((p) => [p.id, p]));

    const plans = await tx.processPlan.findMany({
      where: { scheduleRunId: run.id, unitId: { in: units.map((u) => u.id) } },
      select: {
        unitId: true,
        jobProcessId: true,
        status: true,
        plannedStart: true,
        plannedFinish: true,
        actualStart: true,
        actualFinish: true,
      },
    });

    const edges = await tx.jobProcessEdge.findMany({
      where: { process: { jobId } },
      select: { processId: true, predecessorId: true, type: true },
    });

    const plansByUnit = new Map<number, typeof plans>();
    for (const p of plans) {
      if (p.unitId == null) continue;
      const list = plansByUnit.get(p.unitId) ?? [];
      list.push(p);
      plansByUnit.set(p.unitId, list);
    }

    const ganttUnits: GanttUnit[] = units.map((u) => {
      const unitPlans = plansByUnit.get(u.id) ?? [];
      const bars: GanttBar[] = unitPlans
        .map((p) => {
          const proc = processById.get(p.jobProcessId);
          if (!proc) return null;
          const overdue = p.status !== "COMPLETE" && isOverdue(p.plannedFinish, now);
          const bar: GanttBar = {
            jobProcessId: proc.id,
            code: proc.code,
            name: proc.name,
            seq: proc.seq,
            stageNo: proc.workOrderStages[0] ?? 0,
            deptName: proc.department.name,
            status: p.status,
            overdue,
            plannedStart: p.plannedStart?.toISOString() ?? null,
            plannedFinish: p.plannedFinish?.toISOString() ?? null,
            actualStart: p.actualStart?.toISOString() ?? null,
            actualFinish: p.actualFinish?.toISOString() ?? null,
            standardDays: proc.durationMaxDays,
          };
          return bar;
        })
        .filter((b): b is GanttBar => b != null)
        .sort((a, b) => a.seq - b.seq);
      return { unitId: u.id, serialNo: u.serialNo, bars };
    });

    return {
      units: ganttUnits,
      edges: edges.map((e) => ({ processId: e.processId, predecessorId: e.predecessorId, type: e.type })),
      now: now.toISOString(),
    };
  });
}
