import { withTenant, type Tx } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { workingDaysBetween, DEFAULT_CALENDAR } from "@/lib/schedule";
import type { WorkCalendarInput } from "@/lib/schedule";
import { isOverdue, isOnTime } from "@/lib/shared/business-day";

/**
 * `/departments` + `/departments/[id]` (§4.6) — cross-job, like `/qc`.
 *
 * **"Representative" (mockup's `.rep` field) is a real-data stand-in, not
 * DESPL's actual answer.** CLAUDE.md's C9 open input explicitly lists
 * "department supervisor + representative names" as still outstanding —
 * there is no `representative` field anywhere in the schema. Using the
 * department's assigned `SUPERVISOR`-role user as the displayed name is a
 * reasonable real-data proxy (every department has exactly one in the seed)
 * until DESPL confirms the actual contact; falls back to "—" honestly if a
 * department has none assigned.
 */
export interface DeptCard {
  id: number;
  code: string;
  name: string;
  representative: string | null;
  openCount: number;
  overdueCount: number;
  onTimePct: number | null;
  /** N4 — non-CLOSED Ncrs whose rejected operation/step is owned by this department. */
  openReworkCount: number;
}

/**
 * N2 — open-rework items for a department's detail page, scoped to the
 * department owning the rejected ComponentOperation/AssemblyStep (via
 * OperationRef.defaultDepartmentId or AssemblyTemplateStep.defaultDepartmentId
 * respectively). Separate grain from `DeptOpenItem` (ProcessPlan/JobProcess) —
 * a sibling list, not an extension, since Ncr's owning entity isn't a plan.
 */
export interface DeptReworkItem {
  ncrId: number;
  kind: "COMPONENT_OPERATION" | "ASSEMBLY_STEP";
  entityId: number;
  status: string;
  disposition: string | null;
  reworkOwnerId: number | null;
  reworkDueDate: string | null;
}

interface DeptNcrRow {
  id: number;
  status: string;
  disposition: string | null;
  reworkOwnerId: number | null;
  reworkDueDate: Date | null;
  componentOperationRejection: {
    componentOperation: { id: number; operation: { defaultDepartmentId: number | null } };
  } | null;
  assemblyStepRejection: {
    assemblyStep: { id: number; templateStep: { defaultDepartmentId: number } };
  } | null;
}

/** Open (non-CLOSED) Ncrs tenant-wide, with enough of the rejection→operation/step
 * chain resolved to attribute each to its owning department in JS. */
async function loadOpenNcrs(tx: Tx, tenantId: number): Promise<DeptNcrRow[]> {
  return tx.ncr.findMany({
    where: {
      status: { not: "CLOSED" },
      OR: [
        { componentOperationRejection: { componentOperation: { component: { equipment: { job: { tenantId } } } } } },
        { assemblyStepRejection: { assemblyStep: { unit: { equipment: { job: { tenantId } } } } } },
      ],
    },
    select: {
      id: true,
      status: true,
      disposition: true,
      reworkOwnerId: true,
      reworkDueDate: true,
      componentOperationRejection: {
        select: { componentOperation: { select: { id: true, operation: { select: { defaultDepartmentId: true } } } } },
      },
      assemblyStepRejection: {
        select: { assemblyStep: { select: { id: true, templateStep: { select: { defaultDepartmentId: true } } } } },
      },
    },
  });
}

function reworkDeptId(row: DeptNcrRow): number | null {
  return row.componentOperationRejection?.componentOperation.operation.defaultDepartmentId ?? row.assemblyStepRejection?.assemblyStep.templateStep.defaultDepartmentId ?? null;
}

function toReworkItem(row: DeptNcrRow): DeptReworkItem {
  const isComponent = row.componentOperationRejection != null;
  return {
    ncrId: row.id,
    kind: isComponent ? "COMPONENT_OPERATION" : "ASSEMBLY_STEP",
    entityId: isComponent ? row.componentOperationRejection!.componentOperation.id : row.assemblyStepRejection!.assemblyStep.id,
    status: row.status,
    disposition: row.disposition,
    reworkOwnerId: row.reworkOwnerId,
    reworkDueDate: row.reworkDueDate ? row.reworkDueDate.toISOString() : null,
  };
}

async function resolveCalendar(tx: Tx): Promise<WorkCalendarInput> {
  const cal = await tx.workCalendar.findFirst({ where: { isDefault: true }, include: { holidays: true } });
  return cal ? { weekOffDays: cal.weekOffDays, holidays: cal.holidays.map((h) => h.date) } : DEFAULT_CALENDAR;
}

export async function loadDepartmentCards(actor: Actor): Promise<DeptCard[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const departments = await tx.department.findMany({ orderBy: { id: "asc" } });

    const reps = await tx.userDepartment.findMany({
      where: { department: { id: { in: departments.map((d) => d.id) } }, user: { roles: { some: { role: { code: "SUPERVISOR" } } } } },
      select: { departmentId: true, user: { select: { name: true } } },
    });
    const repByDept = new Map(reps.map((r) => [r.departmentId, r.user.name]));

    const plans = await tx.processPlan.findMany({
      where: { scheduleRun: { isCurrent: true } },
      select: { ownerDepartmentId: true, status: true, plannedFinish: true, actualFinish: true },
    });

    const byDept = new Map<number, { open: number; overdue: number; onTime: number; onTimeTotal: number }>();
    for (const p of plans) {
      const b = byDept.get(p.ownerDepartmentId) ?? { open: 0, overdue: 0, onTime: 0, onTimeTotal: 0 };
      if (p.status !== "COMPLETE") {
        b.open++;
        if (isOverdue(p.plannedFinish)) b.overdue++;
      } else if (p.actualFinish && p.plannedFinish) {
        b.onTimeTotal++;
        if (isOnTime(p.actualFinish, p.plannedFinish)) b.onTime++;
      }
      byDept.set(p.ownerDepartmentId, b);
    }

    const openNcrs = await loadOpenNcrs(tx, actor.tenantId);
    const reworkCountByDept = new Map<number, number>();
    for (const row of openNcrs) {
      const deptId = reworkDeptId(row);
      if (deptId == null) continue;
      reworkCountByDept.set(deptId, (reworkCountByDept.get(deptId) ?? 0) + 1);
    }

    return departments.map((d) => {
      const b = byDept.get(d.id) ?? { open: 0, overdue: 0, onTime: 0, onTimeTotal: 0 };
      return {
        id: d.id,
        code: d.code,
        name: d.name,
        representative: repByDept.get(d.id) ?? null,
        openCount: b.open,
        overdueCount: b.overdue,
        onTimePct: b.onTimeTotal > 0 ? Math.round((b.onTime / b.onTimeTotal) * 100) : null,
        openReworkCount: reworkCountByDept.get(d.id) ?? 0,
      };
    });
  });
}

export interface DeptOpenItem {
  planId: number;
  jobId: number;
  jobNumber: string;
  unitId: number;
  serialNo: string;
  stageNo: number;
  processName: string;
  status: string;
  plannedFinish: string | null;
  overdue: boolean;
}

export interface DeptCycleTimeRow {
  processName: string;
  standardDays: number;
  avgActualDays: number;
  deltaDays: number;
}

export interface DeptReasonBreakdown {
  category: string;
  count: number;
}

export interface DeptDetail {
  id: number;
  code: string;
  name: string;
  isOfficeDept: boolean;
  representative: string | null;
  openItems: DeptOpenItem[];
  cycleTime: DeptCycleTimeRow[];
  reasonBreakdown: DeptReasonBreakdown[];
  /** N2 — open rework items owned by this department. */
  openReworkItems: DeptReworkItem[];
}

export async function loadDepartmentDetail(actor: Actor, deptId: number): Promise<DeptDetail | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const dept = await tx.department.findUnique({ where: { id: deptId } });
    if (!dept) return null;

    const rep = await tx.userDepartment.findFirst({
      where: { departmentId: deptId, user: { roles: { some: { role: { code: "SUPERVISOR" } } } } },
      select: { user: { select: { name: true } } },
    });

    const plans = await tx.processPlan.findMany({
      where: { ownerDepartmentId: deptId, scheduleRun: { isCurrent: true } },
      select: {
        id: true,
        status: true,
        plannedFinish: true,
        actualStart: true,
        actualFinish: true,
        unit: { select: { id: true, serialNo: true } },
        jobProcess: { select: { id: true, name: true, durationMaxDays: true, workOrderStages: true, job: { select: { id: true, jobNumber: true } } } },
      },
    });

    const openItems: DeptOpenItem[] = plans
      .filter((p) => p.status !== "COMPLETE" && p.unit != null)
      .map((p) => ({
        planId: p.id,
        jobId: p.jobProcess.job.id,
        jobNumber: p.jobProcess.job.jobNumber,
        unitId: p.unit!.id,
        serialNo: p.unit!.serialNo,
        stageNo: p.jobProcess.workOrderStages[0] ?? 0,
        processName: p.jobProcess.name,
        status: p.status,
        plannedFinish: p.plannedFinish ? p.plannedFinish.toISOString() : null,
        overdue: isOverdue(p.plannedFinish),
      }))
      .sort((a, b) => (a.plannedFinish ?? "").localeCompare(b.plannedFinish ?? ""));

    const calendar = await resolveCalendar(tx);
    const cycleByProcess = new Map<number, { name: string; standard: number; deltas: number[] }>();
    for (const p of plans) {
      if (p.status !== "COMPLETE" || !p.actualStart || !p.actualFinish) continue;
      const standard = p.jobProcess.durationMaxDays;
      if (standard == null) continue;
      const actualDays = workingDaysBetween(p.actualStart, p.actualFinish, calendar);
      const entry = cycleByProcess.get(p.jobProcess.id) ?? { name: p.jobProcess.name, standard, deltas: [] };
      entry.deltas.push(actualDays - standard);
      cycleByProcess.set(p.jobProcess.id, entry);
    }
    const cycleTime: DeptCycleTimeRow[] = Array.from(cycleByProcess.values())
      .map((e) => {
        const avgDelta = e.deltas.reduce((a, b) => a + b, 0) / e.deltas.length;
        return {
          processName: e.name,
          standardDays: e.standard,
          avgActualDays: Math.round((e.standard + avgDelta) * 10) / 10,
          deltaDays: Math.round(avgDelta * 10) / 10,
        };
      })
      .sort((a, b) => b.deltaDays - a.deltaDays);

    const delayRows = await tx.delayReason.findMany({
      where: { processPlan: { ownerDepartmentId: deptId } },
      select: { category: { select: { name: true } } },
    });
    const reasonCounts = new Map<string, number>();
    for (const r of delayRows) reasonCounts.set(r.category.name, (reasonCounts.get(r.category.name) ?? 0) + 1);
    const reasonBreakdown: DeptReasonBreakdown[] = Array.from(reasonCounts, ([category, count]) => ({ category, count })).sort(
      (a, b) => b.count - a.count,
    );

    const openReworkItems = (await loadOpenNcrs(tx, actor.tenantId))
      .filter((row) => reworkDeptId(row) === deptId)
      .map(toReworkItem);

    return {
      id: dept.id,
      code: dept.code,
      name: dept.name,
      isOfficeDept: dept.isOfficeDept,
      representative: rep?.user.name ?? null,
      openItems,
      cycleTime,
      reasonBreakdown,
      openReworkItems,
    };
  });
}
