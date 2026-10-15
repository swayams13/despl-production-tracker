import type { PrismaClient } from "@/generated/prisma/client";
import type { Actor } from "@/lib/authz";
import type { AssemblyRole } from "@/lib/shared/floor-rules";

/**
 * L1.2d test fixtures: a throwaway org, and jobs built straight on the owner
 * client (no intake, no scheduler) so each case states exactly the floor facts
 * it needs. // ponytail: no cleanup — disposable test DB, per-run org codes.
 */

export interface StepSpec {
  seq: number;
  kind?: "WORK" | "INSPECTION";
  role?: AssemblyRole | null;
  jointRef?: string | null;
  pressurePart?: boolean;
  requiresQc?: boolean;
  /** AssemblyTemplateStep.leadTimeProcessSeq: the process plan this step rolls up into. */
  processSeq?: number | null;
  /** Template step's own jointRef (the legacy "bind a joint before submit" rule). */
  templateJointRef?: string | null;
  /** Link a blocking H point (DESPL party) to this step; open until an execution clears it. */
  hold?: boolean;
}

export interface ComponentSpec {
  tag: string;
  pressure?: boolean;
  /** false = equipment grain (unitId null). Default true. */
  unitGrain?: boolean;
  issued?: boolean;
  heatNumber?: string | null;
  drawing?: "DRAFT" | "RELEASED" | null;
  ops: Array<{ code: string; requiresQc?: boolean }>;
}

export interface ProcessSpec {
  code: string;
  grain?: "JOB" | "UNIT";
  included?: boolean;
  requiresQc?: boolean;
  plannedFinish?: Date | null;
  /** JobProcess.workOrderStages: the board stages this process backs. */
  stages?: number[];
  /** ProcessPlan.status for every unit's plan (default NOT_STARTED). */
  status?: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "COMPLETE" | "ON_HOLD";
}

export interface JobSpec {
  units?: number;
  processes?: ProcessSpec[];
  steps?: StepSpec[];
  components?: ComponentSpec[];
  /** Earliest RELEASED BOM revision (D4 lower bound). */
  releasedAt?: Date;
  orderDate?: Date;
}

/** Operation code → lead-time process seq, per family (OperationRefFamilySeq). */
export const OP_SEQ: Record<string, number> = { CUTTING: 13, ROLLING: 13, FIT_UP: 15, WELDING: 16, NDT: 17 };

export async function makeWorkOrg(owner: PrismaClient, label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;

  const org = await owner.organization.create({ data: { code: `TEST-L12D-${label}-${stamp}`, name: `l12d ${label}` } });
  const tenantId = org.id;
  const fab = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
  const other = await owner.department.create({ data: { tenantId, code: "MS", name: "Machine shop" } });
  const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
  const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
  const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
  const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
  const category = await owner.delayCategoryRef.create({ data: { tenantId, code: "MATERIAL", name: "Material late" } });
  const holdCode = await owner.qcpCodeRef.create({ data: { tenantId, code: "H", label: "Hold", blocksCompletion: true } });
  const drawingType = await owner.drawingTypeRef.create({ data: { tenantId, code: "GA", name: "GA" } });
  const asmTemplate = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "A-Q" } });
  let asmVersion = 0;

  const roleIds = new Map<string, number>();
  const user = async (tag: string, roles: string[] = [], departmentIds: number[] = []) => {
    const u = await owner.user.create({
      data: { tenantId, email: `${uniq(tag)}@test.local`, username: uniq(tag), passwordHash: "x", name: tag, mustChangePassword: false },
    });
    for (const code of roles) {
      if (!roleIds.has(code)) roleIds.set(code, (await owner.role.create({ data: { tenantId, code, name: code } })).id);
      await owner.userRole.create({ data: { userId: u.id, roleId: roleIds.get(code)! } });
    }
    for (const departmentId of departmentIds) await owner.userDepartment.create({ data: { userId: u.id, departmentId } });
    const actor: Actor = {
      userId: u.id,
      tenantId,
      clientId: null,
      name: tag,
      email: u.email,
      roles: roles as Actor["roles"],
      departmentIds,
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    return actor;
  };

  const opRefs = new Map<string, number>();
  const opRef = async (code: string) => {
    if (!opRefs.has(code)) {
      const r = await owner.operationRef.create({ data: { tenantId, code, name: code, defaultDepartmentId: fab.id } });
      if (OP_SEQ[code] != null) {
        await owner.operationRefFamilySeq.create({
          data: { tenantId, operationRefId: r.id, familyId: family.id, leadTimeProcessSeq: OP_SEQ[code] },
        });
      }
      opRefs.set(code, r.id);
    }
    return opRefs.get(code)!;
  };

  async function job(spec: JobSpec) {
    const j = await owner.job.create({
      data: {
        tenantId,
        publicId: uniq("pub"),
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: uniq("JOB"),
        orderDate: spec.orderDate ?? null,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: j.id, name: "Air Receiver" } });
    const units = [];
    for (let i = 0; i < (spec.units ?? 1); i++) {
      units.push(await owner.unit.create({ data: { jobId: j.id, equipmentId: equipment.id, serialNo: uniq("SR") } }));
    }
    if (spec.releasedAt) {
      await owner.bomRevision.create({
        data: { jobId: j.id, equipmentId: equipment.id, revisionNo: 0, status: "RELEASED", releasedAt: spec.releasedAt },
      });
    }

    // Processes and the current schedule run's plans.
    const run = await owner.scheduleRun.create({
      data: { jobId: j.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    const processes = new Map<string, number>();
    const plans = new Map<string, number>(); // `${code}` (JOB grain) or `${code}:${unitIdx}`
    for (const p of spec.processes ?? []) {
      const jp = await owner.jobProcess.create({
        data: {
          jobId: j.id,
          seq: Number(p.code),
          code: p.code,
          name: `Process ${p.code}`,
          departmentId: fab.id,
          included: p.included ?? true,
          grain: p.grain ?? "UNIT",
          requiresQc: p.requiresQc ?? true,
          // A duration so the schedule engine (CPM, used by Today's ranking) accepts the process.
          durationMinDays: 1,
          durationMaxDays: 2,
          workOrderStages: p.stages ?? [],
        },
      });
      processes.set(p.code, jp.id);
      if (p.included === false) continue;
      const base = {
        scheduleRunId: run.id,
        jobProcessId: jp.id,
        ownerDepartmentId: fab.id,
        jobId: j.id,
        plannedFinish: p.plannedFinish ?? null,
        status: p.status ?? ("NOT_STARTED" as const),
        ...(p.status === "COMPLETE" ? { actualFinish: new Date() } : {}),
      };
      if (p.grain === "JOB") {
        plans.set(p.code, (await owner.processPlan.create({ data: { ...base, unitId: null } })).id);
      } else {
        for (const [i, u] of units.entries()) {
          plans.set(`${p.code}:${i}`, (await owner.processPlan.create({ data: { ...base, unitId: u.id } })).id);
        }
      }
    }

    // Assembly sequence: a template version per job, job-level copies per unit.
    const steps = new Map<string, number>(); // `${seq}:${unitIdx}`
    const stepQcp = new Map<number, number>(); // step id -> qcpItemId
    if (spec.steps?.length) {
      const v = await owner.assemblyTemplateVersion.create({
        data: { templateId: asmTemplate.id, version: ++asmVersion, status: "PUBLISHED" },
      });
      const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId: j.id, jobLabel: j.jobNumber, vessel: "AR" } });
      const party = await owner.inspectionParty.create({ data: { qcpTemplateId: qcpTemplate.id, code: org.code, jobId: j.id } });
      let qcpSeq = 0;
      for (const s of spec.steps) {
        const ts = await owner.assemblyTemplateStep.create({
          data: {
            versionId: v.id,
            seq: s.seq,
            groupCode: "E",
            groupName: "g",
            srNo: String(s.seq),
            activity: `step ${s.seq}`,
            kind: s.kind ?? "WORK",
            defaultDepartmentId: fab.id,
            jointRef: s.templateJointRef ?? null,
            leadTimeProcessSeq: s.processSeq ?? null,
          },
        });
        for (const [i, u] of units.entries()) {
          let qcpItemId: number | null = null;
          if (s.hold) {
            const item = await owner.qcpItem.create({
              data: { qcpTemplateId: qcpTemplate.id, sequence: ++qcpSeq, srNo: String(s.seq), kind: "CHECKPOINT", activity: `hold ${s.seq}`, jobId: j.id },
            });
            await owner.qcpItemPartyCode.create({
              data: { qcpItemId: item.id, inspectionPartyId: party.id, qcpCodeId: holdCode.id, jobId: j.id },
            });
            qcpItemId = item.id;
          }
          const row = await owner.assemblyStep.create({
            data: {
              unitId: u.id,
              templateStepId: ts.id,
              seq: s.seq,
              jobId: j.id,
              role: s.role ?? null,
              jointRef: s.jointRef ?? null,
              pressurePart: s.pressurePart ?? false,
              requiresQc: s.requiresQc ?? true,
              qcpItemId,
            },
          });
          steps.set(`${s.seq}:${i}`, row.id);
          if (qcpItemId != null) stepQcp.set(row.id, qcpItemId);
        }
      }
    }

    // Components and their operations (route order = ComponentOperation.seq, no route version).
    const ops = new Map<string, number>(); // `${tag}:${code}:${unitIdx}`
    const components = new Map<string, number>(); // `${tag}:${unitIdx}`
    const revisions = new Map<string, number>(); // `${tag}:${unitIdx}` -> drawing revision id
    for (const c of spec.components ?? []) {
      const type = await owner.componentTypeRef.create({ data: { tenantId, code: uniq(c.tag), name: c.tag } });
      const grains = c.unitGrain === false ? [null] : units.map((_, i) => i);
      for (const i of grains) {
        let governingDrawingId: number | null = null;
        let revisionId: number | null = null;
        if (c.drawing) {
          const d = await owner.assemblyDrawing.create({ data: { jobId: j.id, drawingTypeId: drawingType.id, drawingNo: uniq("GA") } });
          revisionId = (await owner.drawingRevision.create({ data: { jobId: j.id, assemblyDrawingId: d.id, revisionNo: 0, status: c.drawing } })).id;
          governingDrawingId = d.id;
        }
        const comp = await owner.component.create({
          data: {
            jobId: j.id,
            equipmentId: equipment.id,
            unitId: i == null ? null : units[i].id,
            tag: i == null ? uniq(c.tag) : c.tag,
            componentTypeId: type.id,
            pressureRetaining: c.pressure ?? false,
            governingDrawingId,
          },
        });
        components.set(`${c.tag}:${i ?? "eq"}`, comp.id);
        if (revisionId != null) revisions.set(`${c.tag}:${i ?? "eq"}`, revisionId);
        for (const [k, o] of c.ops.entries()) {
          const op = await owner.componentOperation.create({
            data: { componentId: comp.id, seq: k + 1, operationId: await opRef(o.code), jobId: j.id, requiresQc: o.requiresQc ?? true },
          });
          ops.set(`${c.tag}:${o.code}:${i ?? "eq"}`, op.id);
        }
        if (c.issued || c.heatNumber) {
          const bom = await owner.bomItem.create({ data: { jobId: j.id, equipmentId: equipment.id, itemNo: 1, partName: c.tag, sourceQty: "1" } });
          const lot = await owner.stockLot.create({
            data: { jobId: j.id, bomItemId: bom.id, heatNumber: c.heatNumber ?? null, location: "Y1", qty: "1" },
          });
          if (c.issued) {
            await owner.stockTxn.create({ data: { jobId: j.id, stockLotId: lot.id, type: "ISSUE", qty: "1", by: holder.userId, componentId: comp.id } });
          }
        }
      }
    }

    const step = (seq: number, unit = 0) => steps.get(`${seq}:${unit}`)!;
    const op = (tag: string, code: string, unit: number | "eq" = 0) => ops.get(`${tag}:${code}:${unit}`)!;
    const plan = (code: string, unit?: number) => plans.get(unit == null ? code : `${code}:${unit}`)!;
    return { job: j, equipment, units, run, processes, step, op, plan, stepQcp, components, revisions };
  }

  // Owner of fixture stock transactions.
  const holder = await user("holder");

  return { tenantId, org, fab, other, family, category, holdCode, user, job, uniq };
}

export type WorkOrg = Awaited<ReturnType<typeof makeWorkOrg>>;
export type WorkJob = Awaited<ReturnType<WorkOrg["job"]>>;
