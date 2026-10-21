// Lean Core J4a: planned joints for jobs whose steps name their joints as literal text
// (DESPL-320's LS-1, CS-1, CS-2, nozzle lists ...). Derives one planned joint per distinct
// joint number per equipment line, then links the rows that name exactly one joint and the
// as-welded records that carry that number. Never changes a step's template or seq
// (invariant 9). Idempotent; used by scripts/lean-backfill-planned-joints.ts.
import type { Tx } from "@/lib/db";
import type { JointType } from "@/generated/prisma/client";
import { jointRefs } from "@/lib/shared/floor-rules";
import { jointTypeFromNo } from "@/lib/shared/weld-map";

export { jointTypeFromNo };

export interface PlannedJointBackfillReport {
  equipments: number;
  jointsToCreate: { equipmentId: number; jointNo: string; jointType: JointType }[];
  stepsToLink: number;
  weldJointsToLink: number;
  /** Steps that name several joints at once (a comma list): left unlinked, they keep their literal jointRef. */
  multiJointSteps: number;
}

export async function backfillPlannedJoints(
  tx: Tx,
  tenantId: number,
  opts: { apply: boolean; audit?: boolean; auditSource?: string; jobNumber?: string },
): Promise<PlannedJointBackfillReport> {
  const steps = await tx.assemblyStep.findMany({
    where: { tenantId, jointRef: { not: null }, ...(opts.jobNumber ? { job: { jobNumber: opts.jobNumber } } : {}) },
    select: { id: true, seq: true, jobId: true, jointRef: true, plannedJointId: true, unit: { select: { equipmentId: true } } },
    orderBy: [{ jobId: "asc" }, { seq: "asc" }, { id: "asc" }],
  });

  // Distinct joints per equipment, in first-appearance order.
  const wanted = new Map<number, { jobId: number; joints: string[] }>();
  let multiJointSteps = 0;
  for (const s of steps) {
    const refs = jointRefs(s.jointRef);
    if (refs.length > 1) multiJointSteps++;
    const entry = wanted.get(s.unit.equipmentId) ?? { jobId: s.jobId, joints: [] };
    for (const r of refs) if (!entry.joints.includes(r)) entry.joints.push(r);
    wanted.set(s.unit.equipmentId, entry);
  }

  const existing = await tx.plannedJoint.findMany({
    where: { equipmentId: { in: [...wanted.keys()] } },
    select: { id: true, equipmentId: true, jointNo: true },
  });
  const have = new Set(existing.map((j) => `${j.equipmentId}:${j.jointNo}`));
  const jointsToCreate: PlannedJointBackfillReport["jointsToCreate"] = [];
  for (const [equipmentId, w] of wanted) {
    for (const jointNo of w.joints) {
      if (!have.has(`${equipmentId}:${jointNo}`)) jointsToCreate.push({ equipmentId, jointNo, jointType: jointTypeFromNo(jointNo) });
    }
  }

  const unlinkedSingles = steps.filter((s) => s.plannedJointId == null && jointRefs(s.jointRef).length === 1);
  const welds = await tx.weldJoint.findMany({
    where: { tenantId, plannedJointId: null, unitId: { not: null }, ...(opts.jobNumber ? { job: { jobNumber: opts.jobNumber } } : {}) },
    select: { id: true, jointNo: true, unit: { select: { equipmentId: true } } },
  });
  const wantedNos = (eq: number) => new Set(wanted.get(eq)?.joints ?? []);
  const weldsToLink = welds.filter((w) => w.unit && wantedNos(w.unit.equipmentId).has(w.jointNo));

  const report: PlannedJointBackfillReport = {
    equipments: wanted.size,
    jointsToCreate,
    stepsToLink: unlinkedSingles.length,
    weldJointsToLink: weldsToLink.length,
    multiJointSteps,
  };
  if (!opts.apply) return report;

  for (const [equipmentId, w] of wanted) {
    const order = new Map(w.joints.map((j, i) => [j, i]));
    const create = jointsToCreate.filter((j) => j.equipmentId === equipmentId);
    if (create.length === 0) continue;
    await tx.plannedJoint.createMany({
      data: create.map((j) => ({
        jobId: w.jobId,
        equipmentId,
        jointNo: j.jointNo,
        jointType: j.jointType,
        source: "IMPORTED" as const,
        confirmed: false,
        sortOrder: order.get(j.jointNo)!,
      })),
    });
    if (opts.audit) {
      await tx.auditLog.create({
        data: {
          tenantId,
          action: "setup.plannedJoints.backfill",
          entityType: "Equipment",
          entityId: String(equipmentId),
          before: undefined,
          after: { joints: create.map((j) => j.jointNo), source: "IMPORTED", confirmed: false },
          userAgent: opts.auditSource ?? "planned-joint.setup",
        },
      });
    }
  }

  const all = await tx.plannedJoint.findMany({
    where: { equipmentId: { in: [...wanted.keys()] } },
    select: { id: true, equipmentId: true, jointNo: true },
  });
  const idOf = new Map(all.map((j) => [`${j.equipmentId}:${j.jointNo}`, j.id]));
  for (const s of unlinkedSingles) {
    const id = idOf.get(`${s.unit.equipmentId}:${jointRefs(s.jointRef)[0]}`);
    if (id != null) await tx.assemblyStep.update({ where: { id: s.id }, data: { plannedJointId: id } });
  }
  for (const w of weldsToLink) {
    const id = idOf.get(`${w.unit!.equipmentId}:${w.jointNo}`);
    if (id != null) await tx.weldJoint.update({ where: { id: w.id }, data: { plannedJointId: id } });
  }
  return report;
}
