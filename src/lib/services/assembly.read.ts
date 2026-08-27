import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import type { OperationStatus, TestResult } from "@/generated/prisma/client";
import type { UnitOption, WelderOption, DelayCategoryOption } from "./bom.read";

/**
 * Job detail — Assembly tab (Phase 2, A6). Same shape family as bom.read.ts's
 * BomTree: one unit at a time, grouped rows, pickers for the inline forms.
 * `AssemblyStep` is the vessel-level A–Q checkpoint grain (addendum §2) —
 * distinct from bom.read.ts's per-component BomComponentOp.
 */

export interface AssemblyNdtResultRow {
  id: number;
  testTypeName: string;
  result: TestResult;
}

export interface AssemblyWeldJointRow {
  id: number;
  jointNo: string;
  jointType: string;
  welderNames: string[];
  ndtResults: AssemblyNdtResultRow[];
}

export interface AssemblyQcpCheckpoint {
  id: number;
  srNo: string;
  activity: string;
}

export interface AssemblyRejectionRow {
  categoryName: string;
  detail: string | null;
}

export interface AssemblyStepRow {
  id: number;
  seq: number;
  srNo: string;
  activity: string;
  kind: "WORK" | "INSPECTION";
  status: OperationStatus;
  startedAt: string | null;
  finishedAt: string | null;
  submittedBy: number | null;
  performedByWelderName: string | null;
  performedByUserName: string | null;
  remarks: string | null;
  /** Printed weld-map reference from the template ("LS-1") — set only on the three single-joint weld groups. */
  jointRef: string | null;
  weldJoint: AssemblyWeldJointRow | null;
  qcpItem: AssemblyQcpCheckpoint | null;
  rejection: AssemblyRejectionRow | null;
}

export interface AssemblyGroup {
  groupCode: string;
  groupName: string;
  steps: AssemblyStepRow[];
}

export interface TestTypeOption {
  id: number;
  name: string;
}

export interface AssemblyGrid {
  units: UnitOption[];
  unitId: number | null;
  /** False when the job's family has no AssemblyTemplateVersion pinned yet — the empty-state case. */
  hasTemplate: boolean;
  groups: AssemblyGroup[];
  welders: WelderOption[];
  delayCategories: DelayCategoryOption[];
  testTypes: TestTypeOption[];
}

export async function loadAssemblyGrid(actor: Actor, jobId: number, unitId?: number): Promise<AssemblyGrid | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: jobId },
      select: { clientId: true, assemblyTemplateVersionId: true },
    });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const equipment = await tx.equipment.findFirst({ where: { jobId }, select: { id: true }, orderBy: { id: "asc" } });
    const units = equipment
      ? await tx.unit.findMany({
          where: { equipmentId: equipment.id },
          select: { id: true, serialNo: true },
          orderBy: { serialNo: "asc" },
        })
      : [];

    const [welders, delayCategories, testTypes] = await Promise.all([
      tx.welder.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      tx.delayCategoryRef.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      tx.testTypeRef.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    if (job.assemblyTemplateVersionId == null || units.length === 0) {
      return {
        units,
        unitId: null,
        hasTemplate: job.assemblyTemplateVersionId != null,
        groups: [],
        welders,
        delayCategories,
        testTypes,
      };
    }

    const targetUnitId = unitId != null && units.some((u) => u.id === unitId) ? unitId : units[0].id;

    const steps = await tx.assemblyStep.findMany({
      where: { unitId: targetUnitId },
      orderBy: { seq: "asc" },
      select: {
        id: true,
        seq: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        submittedBy: true,
        remarks: true,
        performedByWelder: { select: { name: true } },
        performedByUser: { select: { name: true } },
        templateStep: {
          select: { groupCode: true, groupName: true, srNo: true, activity: true, kind: true, jointRef: true },
        },
        weldJoint: {
          select: {
            id: true,
            jointNo: true,
            jointType: true,
            welders: { select: { welder: { select: { name: true } } } },
            ndtResults: {
              orderBy: { id: "desc" },
              select: { id: true, result: true, testType: { select: { name: true } } },
            },
          },
        },
        qcpItem: { select: { id: true, srNo: true, activity: true } },
        rejections: {
          orderBy: { rejectedAt: "desc" },
          take: 1,
          select: { detail: true, category: { select: { name: true } } },
        },
      },
    });

    const byGroup = new Map<string, AssemblyGroup>();
    for (const s of steps) {
      const key = s.templateStep.groupCode;
      const group = byGroup.get(key) ?? { groupCode: key, groupName: s.templateStep.groupName, steps: [] };
      group.steps.push({
        id: s.id,
        seq: s.seq,
        srNo: s.templateStep.srNo,
        activity: s.templateStep.activity,
        kind: s.templateStep.kind,
        status: s.status,
        startedAt: s.startedAt?.toISOString() ?? null,
        finishedAt: s.finishedAt?.toISOString() ?? null,
        submittedBy: s.submittedBy,
        performedByWelderName: s.performedByWelder?.name ?? null,
        performedByUserName: s.performedByUser?.name ?? null,
        remarks: s.remarks,
        jointRef: s.templateStep.jointRef,
        weldJoint: s.weldJoint
          ? {
              id: s.weldJoint.id,
              jointNo: s.weldJoint.jointNo,
              jointType: s.weldJoint.jointType,
              welderNames: s.weldJoint.welders.map((w) => w.welder.name),
              ndtResults: s.weldJoint.ndtResults.map((n) => ({ id: n.id, testTypeName: n.testType.name, result: n.result })),
            }
          : null,
        qcpItem: s.qcpItem,
        rejection: s.rejections[0] ? { categoryName: s.rejections[0].category.name, detail: s.rejections[0].detail } : null,
      });
      byGroup.set(key, group);
    }

    return {
      units,
      unitId: targetUnitId,
      hasTemplate: true,
      groups: [...byGroup.values()],
      welders,
      delayCategories,
      testTypes,
    };
  });
}
