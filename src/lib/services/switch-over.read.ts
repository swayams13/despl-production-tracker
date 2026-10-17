import { withTenant } from "@/lib/db";
import { assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { OFFICE_PROCESS_MAX_SEQ, type WorkKind } from "@/lib/shared/floor-rules";

/**
 * Lean Core L2.10 part B: the list a Production Head ticks at the switch-over
 * from Excel. Every floor item of the job that is not done yet, per unit, in the
 * order recordWork must receive it (so a later item sees an earlier one's new
 * status in the same batch). Inspection steps are QC's, so they are not listed.
 */

/** Production Head and Admin: a planner may only record processes 1–11, a supervisor only their departments. */
export const SWITCH_OVER_ROLES = [ROLES.PRODUCTION_HEAD, ROLES.ADMIN] as const;

export interface SwitchRow {
  /** `${kind}:${id}` */
  key: string;
  kind: WorkKind;
  id: number;
  title: string;
  group: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "COMPLETE" | string;
  /** The same step or operation on the next unit has the same match key. */
  matchKey: string;
  /** Position in the order recordWork must receive them. */
  order: number;
}

export interface SwitchUnit {
  /** null = the job's own items: office processes and parts not tied to a unit. */
  unitId: number | null;
  label: string;
  rows: SwitchRow[];
}

export interface SwitchOverView {
  job: { id: number; jobNumber: string; projectName: string | null };
  units: SwitchUnit[];
  lateCategories: Array<{ id: number; name: string; code: string }>;
  /** Items still open / items in the job, for the header. */
  open: number;
  total: number;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export async function loadSwitchOver(actor: Actor, jobId: number): Promise<SwitchOverView> {
  assertNotClientUser(actor);
  requireRole(actor, ...SWITCH_OVER_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findFirst({ where: { id: jobId, tenantId: actor.tenantId }, select: { id: true, jobNumber: true, projectName: true } });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });

    const [units, steps, ops, plans, categories] = await Promise.all([
      tx.unit.findMany({ where: { equipment: { jobId } }, select: { id: true, serialNo: true } }),
      tx.assemblyStep.findMany({
        where: { jobId, templateStep: { kind: "WORK" } },
        select: { id: true, unitId: true, seq: true, status: true, templateStepId: true, templateStep: { select: { activity: true, groupName: true } } },
      }),
      tx.componentOperation.findMany({
        where: { jobId },
        select: { id: true, seq: true, status: true, operationId: true, operation: { select: { name: true } }, component: { select: { id: true, tag: true, unitId: true } } },
      }),
      tx.processPlan.findMany({
        where: { jobId, unitId: null, scheduleRun: { isCurrent: true } },
        select: { id: true, status: true, jobProcess: { select: { code: true, name: true } } },
      }),
      tx.delayCategoryRef.findMany({ where: { tenantId: actor.tenantId, active: true }, orderBy: { id: "asc" }, select: { id: true, name: true, code: true } }),
    ]);

    const byUnit = new Map<number | null, SwitchRow[]>();
    const add = (unitId: number | null, row: Omit<SwitchRow, "order">) => {
      const list = byUnit.get(unitId) ?? [];
      list.push({ ...row, order: 0 });
      byUnit.set(unitId, list);
    };

    // 1. Office processes (job grain), by process number.
    for (const p of [...plans].sort((a, b) => Number(a.jobProcess.code) - Number(b.jobProcess.code))) {
      const n = /^\d+$/.test(p.jobProcess.code) ? Number(p.jobProcess.code) : null;
      if (n == null || n > OFFICE_PROCESS_MAX_SEQ) continue;
      add(null, { key: `PROCESS_PLAN:${p.id}`, kind: "PROCESS_PLAN", id: p.id, title: p.jobProcess.name, group: "Planning and procurement", status: p.status, matchKey: `P:${p.jobProcess.code}` });
    }
    // 2. Component operations, per component then route position.
    for (const o of [...ops].sort((a, b) => a.component.id - b.component.id || a.seq - b.seq)) {
      add(o.component.unitId, {
        key: `COMPONENT_OP:${o.id}`, kind: "COMPONENT_OP", id: o.id, title: `${o.component.tag} · ${o.operation.name}`, group: "Parts", status: o.status,
        matchKey: `O:${o.component.tag}:${o.operationId}`,
      });
    }
    // 3. Assembly steps, in the unit's assembly sequence.
    for (const s of [...steps].sort((a, b) => a.seq - b.seq)) {
      add(s.unitId, { key: `ASSEMBLY_STEP:${s.id}`, kind: "ASSEMBLY_STEP", id: s.id, title: s.templateStep.activity, group: s.templateStep.groupName, status: s.status, matchKey: `S:${s.templateStepId}` });
    }

    const out: SwitchUnit[] = [];
    const label = new Map(units.map((u) => [u.id, u.serialNo]));
    const ordered = [...byUnit.keys()].sort((a, b) => (a === null ? -1 : b === null ? 1 : natural(label.get(a) ?? "", label.get(b) ?? "")));
    let open = 0;
    let total = 0;
    for (const unitId of ordered) {
      const rows = byUnit.get(unitId)!.map((r, i) => ({ ...r, order: i }));
      total += rows.length;
      open += rows.filter((r) => r.status === "NOT_STARTED" || r.status === "IN_PROGRESS").length;
      out.push({ unitId, label: unitId === null ? "Job level" : (label.get(unitId) ?? `Unit ${unitId}`), rows });
    }
    return { job, units: out, lateCategories: categories, open, total };
  });
}
