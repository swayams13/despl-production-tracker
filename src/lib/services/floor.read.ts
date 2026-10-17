import { withTenant } from "@/lib/db";
import { assertNotClientUser, hasRole, ROLES, type Actor, type RoleCode } from "@/lib/authz";
import { ERROR_CODES, ERROR_MESSAGES, SEQUENCE_OVERRIDE_OPERATOR_MESSAGE, type ErrorCode } from "@/lib/shared/errors";
import { canOverride, checkStart, evaluateHard, type FloorItem } from "@/lib/shared/floor-rules";
import { istCalendarDayMarker } from "@/lib/shared/business-day";
import { OVERRIDE_CATEGORIES } from "@/lib/shared/schemas";
import type { StageSegment } from "@/components/industrial/stage-status";
import { loadFloorFacts, rowKey } from "./work.facts";
import { loadUnitSpinesBatch } from "./spine.read";

/**
 * Lean Core L2.2: everything the Floor screen (/u/[publicId]) needs, for one
 * unit and the viewer's departments. Read-only: it evaluates the same D2 rule
 * registry recordWork enforces (loadFloorFacts + evaluateHard/checkStart), so a
 * row is shown as ready only when a Start would pass the registry. The write
 * path stays the judge: kit-ready and date-window checks still refuse there,
 * and the screen shows that refusal as it does any other.
 */

export type FloorRowState = "READY" | "IN_PROGRESS" | "WITH_QC" | "BLOCKED" | "NEEDS_OVERRIDE" | "QC_STEP";

/** Who can clear a refusal, for the "Notify <role>" button. null = nobody to nudge (a rule NCR, a data gap). */
export interface FloorRefusal {
  code: ErrorCode;
  message: string;
  clearedBy: { role: RoleCode; label: string } | null;
  /** The first earlier items the rule names, in floor language (titles). */
  missing: string[];
  /** How many more the rule names beyond `missing` (an out-of-order step can have dozens open). */
  moreMissing: number;
}

export interface FloorSibling {
  unitId: number;
  serialNo: string;
  id: number;
  status: "NOT_STARTED" | "IN_PROGRESS";
}

export interface FloorRow {
  key: string;
  kind: "COMPONENT_OP" | "ASSEMBLY_STEP";
  id: number;
  title: string;
  group: string;
  state: FloorRowState;
  /** ISO of the reported (else recorded) start, for an in-progress row. */
  startedAt: string | null;
  /** The process plan this item rolls up into (unit plan, else the job's), and its seq. */
  planId: number | null;
  processSeq: number | null;
  /** ISO of the plan's planned finish; null = not scheduled. */
  dueAt: string | null;
  /** Done now would be late and no reason is on file for its plan. */
  lateReasonNeeded: boolean;
  refusal: FloorRefusal | null;
  /** Supervisor and above may start this early with a reason (NEEDS_OVERRIDE). */
  canOverride: boolean;
  /** A step that needs a joint bound before Done (L1.2d JOINT_REQUIRED). */
  weld: { jointRef: string; existingJointId: number | null } | null;
  /** A pressure-part cutting item refused only for a missing heat number: the part to pick it for (L2.13). */
  heatComponentId: number | null;
  /** The same step on the unit's siblings, not yet done. Empty for weld steps (one joint per unit). */
  siblings: FloorSibling[];
}

export interface FloorUnitView {
  unit: { id: number; publicId: string; serialNo: string; jobId: number; jobNumber: string; projectName: string | null; equipmentName: string };
  spine: StageSegment[];
  /** The viewer may record (Done / Start); false = read-only (QC, Management, Planner here). */
  canRecord: boolean;
  /** Department names the rows were filtered to; empty = all (Production Head, Admin). */
  departments: string[];
  rows: FloorRow[];
  lateCategories: Array<{ id: number; name: string }>;
  welders: Array<{ id: number; name: string; employeeCode: string }>;
  overrideCategories: readonly string[];
  /** Items hidden because they are COMPLETE, for the "n done" line. */
  doneCount: number;
  /** Process plans (this unit's and the job's) whose status is derived from mapped steps / ops: never recorded directly. */
  derivedPlanIds: number[];
}

const FLOOR_RECORD_ROLES = [ROLES.OPERATOR, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN] as const;
const ROW_CAP = 60;
const MISSING_SHOWN = 3;

const RANK: Record<FloorRowState, number> = {
  IN_PROGRESS: 0,
  READY: 1,
  NEEDS_OVERRIDE: 2,
  BLOCKED: 3,
  WITH_QC: 4,
  QC_STEP: 5,
};

/** Rule code -> the role that clears it. Plain data: the message text is ERROR_MESSAGES' own. */
const CLEARED_BY: Partial<Record<ErrorCode, RoleCode>> = {
  HOLD_POINT_OPEN: ROLES.QC,
  MATERIAL_NOT_ISSUED: ROLES.STORES,
  HEAT_NUMBER_NOT_PICKED: ROLES.STORES,
  MATERIAL_NOT_AVAILABLE: ROLES.STORES,
  DRAWING_NOT_RELEASED: ROLES.ENGINEERING,
  WELD_AFTER_PWHT: ROLES.QC,
  WELD_AFTER_HYDRO: ROLES.QC,
  HYDRO_PREREQUISITES_INCOMPLETE: ROLES.QC,
  PWHT_NOT_COMPLETE: ROLES.PRODUCTION_HEAD,
};
const ROLE_LABEL: Partial<Record<RoleCode, string>> = {
  QC: "Quality Control",
  STORES: "Stores",
  ENGINEERING: "Engineering",
  PRODUCTION_HEAD: "the Production Head",
};

export function refusalFor(
  code: ErrorCode,
  meta: Record<string, unknown>,
  titles: Map<string, string>,
  operator = false,
): FloorRefusal {
  const open = [...((meta.open as unknown[]) ?? []), ...((meta.held as unknown[]) ?? [])] as Array<{ kind: string; id: number }>;
  const named = open.map((o) => titles.get(rowKey(o.kind as "COMPONENT_OP", o.id))).filter((t): t is string => !!t);
  const role = CLEARED_BY[code] ?? null;
  return {
    code,
    message: operator ? SEQUENCE_OVERRIDE_OPERATOR_MESSAGE : ERROR_MESSAGES[code],
    clearedBy: role && ROLE_LABEL[role] ? { role, label: ROLE_LABEL[role]! } : null,
    missing: named.slice(0, MISSING_SHOWN),
    moreMissing: Math.max(0, open.length - MISSING_SHOWN),
  };
}

/** A unit by its QR id (the Floor screen) or by row id (Today, which already holds ids). */
export type FloorUnitRef = string | { unitId: number };

export async function loadFloorUnit(
  actor: Actor,
  ref: FloorUnitRef,
  opts: { spine?: boolean } = {},
): Promise<FloorUnitView | null> {
  assertNotClientUser(actor);
  const seen = await withTenant(actor.tenantId, async (tx) => {
    const unit = await tx.unit.findUnique({
      where: typeof ref === "string" ? { publicId: ref } : { id: ref.unitId },
      select: {
        id: true,
        publicId: true,
        serialNo: true,
        jobId: true,
        job: { select: { id: true, familyId: true, jobNumber: true, projectName: true } },
        equipment: { select: { name: true } },
      },
    });
    if (!unit || unit.job.id !== unit.jobId) return null;

    const all = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);
    const deptIds = actor.departmentIds;
    const inScope = (departmentId: number | null) => all || (departmentId != null && deptIds.includes(departmentId));

    const { facts, rows: factRows, plansBySeq } = await loadFloorFacts(tx, unit.job, unit.id);

    const [stepLabels, opLabels, departments, categories, welders] = await Promise.all([
      tx.assemblyStep.findMany({
        where: { unitId: unit.id, jobId: unit.jobId },
        select: { id: true, templateStepId: true, templateStep: { select: { activity: true, groupName: true } } },
      }),
      tx.componentOperation.findMany({
        where: { jobId: unit.jobId, component: { unitId: unit.id } },
        select: {
          id: true,
          operationId: true,
          operation: { select: { name: true } },
          component: { select: { tag: true, componentType: { select: { name: true } } } },
        },
      }),
      all ? Promise.resolve([]) : tx.department.findMany({ where: { id: { in: deptIds } }, select: { name: true } }),
      tx.delayCategoryRef.findMany({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { id: "asc" },
        select: { id: true, name: true },
      }),
      tx.welder.findMany({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, employeeCode: true },
      }),
    ]);

    const label = new Map<string, { title: string; group: string; templateStepId?: number; operationId?: number; tag?: string }>();
    for (const s of stepLabels) {
      label.set(rowKey("ASSEMBLY_STEP", s.id), {
        title: s.templateStep.activity,
        group: s.templateStep.groupName,
        templateStepId: s.templateStepId,
      });
    }
    for (const o of opLabels) {
      const type = o.component.componentType.name;
      label.set(rowKey("COMPONENT_OP", o.id), {
        title: o.operation.name,
        group: o.component.tag.toLowerCase().includes(type.toLowerCase()) ? o.component.tag : `${type} · ${o.component.tag}`,
        operationId: o.operationId,
        tag: o.component.tag,
      });
    }
    const titles = new Map([...label].map(([k, v]) => [k, v.title]));

    const now = new Date();
    const dayMarker = istCalendarDayMarker(now);
    const rows: FloorRow[] = [];
    let doneCount = 0;
    const roles = actor.roles;

    for (const item of facts.items as FloorItem[]) {
      if (item.kind === "PROCESS_PLAN") continue;
      const key = rowKey(item.kind, item.id);
      const row = factRows.get(key);
      const lab = label.get(key);
      if (!row || !lab || !inScope(row.departmentId)) continue;
      if (item.status === "COMPLETE") {
        doneCount++;
        continue;
      }

      let state: FloorRowState;
      let refusal: FloorRefusal | null = null;
      let overridable = false;
      if (row.stepKind === "INSPECTION") {
        state = "QC_STEP";
      } else if (item.status === "SUBMITTED") {
        state = "WITH_QC";
      } else if (item.status === "ON_HOLD") {
        state = "BLOCKED";
        refusal = { code: "GATING_BLOCKED" as ErrorCode, message: "This item is on hold.", clearedBy: null, missing: [], moreMissing: 0 };
      } else if (item.status === "IN_PROGRESS") {
        const hard = evaluateHard(item, facts, "DONE");
        state = hard ? "BLOCKED" : "IN_PROGRESS";
        if (hard) refusal = refusalFor(hard.code, hard.meta, titles);
      } else {
        const check = checkStart(item, facts, { roles, hasOverride: false });
        if (check.ok) {
          state = "READY";
        } else if (check.code === "SEQUENCE_OVERRIDE_REQUIRED") {
          state = "NEEDS_OVERRIDE";
          overridable = canOverride(roles);
          refusal = refusalFor(check.code, check.meta, titles, !overridable);
        } else {
          state = "BLOCKED";
          refusal = refusalFor(check.code, check.meta, titles);
        }
      }

      const plan = item.processSeq != null ? plansBySeq.get(item.processSeq) : undefined;
      const late = !!plan?.plannedFinish && plan.plannedFinish < dayMarker;
      const jointRef = row.templateJointRef ?? null;
      rows.push({
        key,
        kind: item.kind,
        id: item.id,
        title: lab.title,
        group: lab.group,
        state,
        startedAt: item.status === "IN_PROGRESS" ? (row.startedAt?.toISOString() ?? null) : null,
        planId: plan?.item.id ?? null,
        processSeq: item.processSeq,
        dueAt: plan?.plannedFinish?.toISOString() ?? null,
        lateReasonNeeded: late && !plan?.hasDelayReason,
        refusal,
        canOverride: overridable,
        weld: jointRef && row.weldJointId == null ? { jointRef, existingJointId: null } : null,
        heatComponentId: refusal?.code === ERROR_CODES.HEAT_NUMBER_NOT_PICKED && item.kind === "COMPONENT_OP" ? (row.componentId ?? null) : null,
        siblings: [],
      });
    }

    rows.sort((a, b) => RANK[a.state] - RANK[b.state] || a.group.localeCompare(b.group) || a.id - b.id);
    const shown = rows.slice(0, ROW_CAP);

    // Weld steps: is the joint already logged on this unit (another step of the group bound it)?
    const refs = [...new Set(shown.flatMap((r) => (r.weld ? [r.weld.jointRef] : [])))];
    if (refs.length) {
      const joints = await tx.weldJoint.findMany({
        where: { jobId: unit.jobId, unitId: unit.id, jointNo: { in: refs } },
        select: { id: true, jointNo: true },
      });
      const byNo = new Map(joints.map((j) => [j.jointNo, j.id]));
      for (const r of shown) if (r.weld) r.weld.existingJointId = byNo.get(r.weld.jointRef) ?? null;
    }

    // Same step on the other units (batch picker). Only rows that can be acted on; weld steps stay single.
    const actionable = shown.filter((r) => (r.state === "READY" || r.state === "IN_PROGRESS") && !r.weld);
    const stepTemplateIds = [...new Set(actionable.flatMap((r) => (label.get(r.key)?.templateStepId ? [label.get(r.key)!.templateStepId!] : [])))];
    const opIds = [...new Set(actionable.flatMap((r) => (label.get(r.key)?.operationId ? [label.get(r.key)!.operationId!] : [])))];
    const [sibSteps, sibOps] = await Promise.all([
      stepTemplateIds.length
        ? tx.assemblyStep.findMany({
            where: { jobId: unit.jobId, unitId: { not: unit.id }, templateStepId: { in: stepTemplateIds }, status: { in: ["NOT_STARTED", "IN_PROGRESS"] } },
            select: { id: true, unitId: true, templateStepId: true, status: true, unit: { select: { serialNo: true } } },
            orderBy: { unitId: "asc" },
          })
        : Promise.resolve([]),
      opIds.length
        ? tx.componentOperation.findMany({
            where: {
              jobId: unit.jobId,
              operationId: { in: opIds },
              status: { in: ["NOT_STARTED", "IN_PROGRESS"] },
              component: { unitId: { not: unit.id } },
            },
            select: {
              id: true,
              operationId: true,
              status: true,
              component: { select: { tag: true, unitId: true, unit: { select: { serialNo: true } } } },
            },
            orderBy: { id: "asc" },
          })
        : Promise.resolve([]),
    ]);
    for (const r of actionable) {
      const lab = label.get(r.key)!;
      if (r.kind === "ASSEMBLY_STEP") {
        r.siblings = sibSteps
          .filter((s) => s.templateStepId === lab.templateStepId)
          .map((s) => ({ unitId: s.unitId, serialNo: s.unit.serialNo, id: s.id, status: s.status as "NOT_STARTED" | "IN_PROGRESS" }));
      } else {
        r.siblings = sibOps
          .filter((o) => o.operationId === lab.operationId && o.component.tag === lab.tag && o.component.unitId != null)
          .map((o) => ({
            unitId: o.component.unitId!,
            serialNo: o.component.unit!.serialNo,
            id: o.id,
            status: o.status as "NOT_STARTED" | "IN_PROGRESS",
          }));
      }
    }

    const derivedPlanIds = [...factRows.values()].filter((r) => r.item.kind === "PROCESS_PLAN" && r.derived).map((r) => r.item.id);
    return { unit, shown, doneCount, derivedPlanIds, departments: departments.map((d) => d.name), categories, welders };
  });
  if (!seen) return null;

  const spine =
    opts.spine === false
      ? []
      : ((await loadUnitSpinesBatch(actor, [seen.unit.jobId])).get(seen.unit.jobId)?.find((s) => s.unitId === seen.unit.id)?.segments ?? []);

  return {
    unit: {
      id: seen.unit.id,
      publicId: seen.unit.publicId,
      serialNo: seen.unit.serialNo,
      jobId: seen.unit.jobId,
      jobNumber: seen.unit.job.jobNumber,
      projectName: seen.unit.job.projectName,
      equipmentName: seen.unit.equipment.name,
    },
    spine,
    canRecord: hasRole(actor, ...FLOOR_RECORD_ROLES),
    departments: seen.departments,
    rows: seen.shown,
    lateCategories: seen.categories,
    welders: seen.welders,
    overrideCategories: OVERRIDE_CATEGORIES,
    doneCount: seen.doneCount,
    derivedPlanIds: seen.derivedPlanIds,
  };
}
