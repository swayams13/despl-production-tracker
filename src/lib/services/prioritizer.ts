import { startReadiness } from "@/lib/schedule";
import type { ScheduleEdge, PredecessorState } from "@/lib/schedule";
import type { ProcessPlan } from "@/generated/prisma/client";

export type PlanState = "BLOCKED" | "READY" | "IN_PROGRESS" | "SUBMITTED" | "ON_HOLD" | "DONE";

export interface RankedPlan {
  plan: ProcessPlan;
  state: PlanState;
  overdue: boolean;
  reasonCode: string;
  reasonText: string;
  criticalPath: boolean;
  floatDays: number;
}

export interface PrioritizeInput {
  plans: ProcessPlan[];
  edges: ScheduleEdge[]; // engine edges for the whole spine (jobEdgeToScheduleEdge)
  floatByProcessId: Map<number, { totalFloat: number; isCritical: boolean }>;
  processNameById: Map<number, string>;
  today: Date;
}

// Rank buckets — lower is higher priority.
function bucket(r: { state: PlanState; overdue: boolean; criticalPath: boolean }): number {
  if (r.state === "DONE") return 6;
  if (r.overdue) return 0;
  const actionable = r.state === "READY" || r.state === "IN_PROGRESS" || r.state === "SUBMITTED";
  if (r.criticalPath && actionable) return 1;
  if (r.state === "READY") return 2;
  if (actionable || r.state === "ON_HOLD") return 3;
  return 4; // BLOCKED
}

export function prioritize(input: PrioritizeInput): Map<number, RankedPlan[]> {
  const { plans, edges, floatByProcessId, processNameById, today } = input;

  // status lookup keyed by (jobProcessId, unitId) for same-unit predecessor reads.
  const key = (jobProcessId: number, unitId: number | null) => `${jobProcessId}:${unitId ?? "null"}`;
  const statusByKey = new Map(plans.map((p) => [key(p.jobProcessId, p.unitId), p.status]));
  const edgesByProc = new Map<number, ScheduleEdge[]>();
  for (const e of edges) {
    if (!edgesByProc.has(e.processId)) edgesByProc.set(e.processId, []);
    edgesByProc.get(e.processId)!.push(e);
  }

  const ranked: RankedPlan[] = plans.map((plan) => {
    const cpm = floatByProcessId.get(plan.jobProcessId);
    const criticalPath = cpm?.isCritical ?? false;
    const floatDays = cpm?.totalFloat ?? 0;
    const overdue =
      plan.plannedFinish != null && plan.plannedFinish < today && plan.status !== "COMPLETE";

    let state: PlanState;
    let reasonCode: string = plan.status;
    let reasonText: string;

    switch (plan.status) {
      case "COMPLETE": state = "DONE"; reasonText = "Complete."; break;
      case "IN_PROGRESS": state = "IN_PROGRESS"; reasonText = "In progress."; break;
      case "SUBMITTED": state = "SUBMITTED"; reasonText = "Submitted — awaiting QC verification."; break;
      case "ON_HOLD": state = "ON_HOLD"; reasonText = "On hold."; break;
      default: {
        const procEdges = edgesByProc.get(plan.jobProcessId) ?? [];
        const predStates: PredecessorState[] = procEdges.map((e) => ({
          predecessorId: e.predecessorId,
          status: statusByKey.get(key(e.predecessorId, plan.unitId)) ?? "NOT_STARTED",
        }));
        const { ready, blockingPredecessorIds } = startReadiness(procEdges, predStates);
        if (ready) {
          state = "READY"; reasonCode = "READY";
          reasonText = criticalPath ? "Ready to start — on the critical path." : "Ready to start.";
        } else {
          state = "BLOCKED"; reasonCode = "BLOCKED";
          const names = blockingPredecessorIds.map((id) => processNameById.get(id) ?? `#${id}`);
          reasonText = `Waiting on: ${names.join(", ")}.`;
        }
      }
    }
    if (overdue) {
      reasonCode = "OVERDUE";
      reasonText = `Overdue — file a delay reason to continue. ${reasonText}`;
    }
    return { plan, state, overdue, reasonCode, reasonText, criticalPath, floatDays };
  });

  // Group by department, sort within each: bucket, then earliest plannedFinish, then unit.
  const byDept = new Map<number, RankedPlan[]>();
  for (const r of ranked) {
    const deptId = r.plan.ownerDepartmentId;
    if (!byDept.has(deptId)) byDept.set(deptId, []);
    byDept.get(deptId)!.push(r);
  }
  for (const list of byDept.values()) {
    list.sort((a, b) => {
      const ba = bucket(a), bb = bucket(b);
      if (ba !== bb) return ba - bb;
      const fa = a.plan.plannedFinish?.getTime() ?? Infinity;
      const fb = b.plan.plannedFinish?.getTime() ?? Infinity;
      if (fa !== fb) return fa - fb;
      return (a.plan.unitId ?? 0) - (b.plan.unitId ?? 0);
    });
  }
  return byDept;
}
