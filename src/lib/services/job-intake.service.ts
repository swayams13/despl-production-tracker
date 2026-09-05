import { randomUUID } from "node:crypto";
import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { ROLES, requireRole, assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createJobSchema,
  updateJobDatesSchema,
  updateJobDetailsSchema,
  setJobStatusSchema,
  type CreateJobInput,
  type UpdateJobDatesInput,
  type UpdateJobDetailsInput,
  type SetJobStatusInput,
} from "@/lib/shared/schemas";
import { validateSpecs } from "@/lib/shared/specs";
import { notifyJobCreated } from "./notifications.service";
import { materializeComponentsFromBomItems } from "./component.service";
import { materializeAssemblyStepsFromTemplate } from "./assembly.service";

/**
 * Job intake (docs/superpowers/specs/2026-08-22-job-intake-design.md).
 *
 * Creating a job is not one insert. A usable job needs, atomically: the Job
 * row, its OWN copy of the pinned template's processes and edges, at least one
 * Equipment, its Unit serials, and an audit record. Get any of that wrong and
 * the job renders in the list, then breaks on every screen that reads the
 * spine.
 *
 * Scheduling is deliberately NOT part of this transaction — see the note on
 * the return type.
 */

export interface CreateJobResult {
  jobId: number;
  publicId: string;
  processCount: number;
  edgeCount: number;
  unitCount: number;
  qcpItemCount: number;
  bomItemCount: number;
  /** Component rows materialised from the copied BOM's typed items — see materializeComponentsFromBomItems. */
  componentCount: number;
  /** AssemblyStep rows materialised per unit from the family's AssemblyTemplate — see materializeAssemblyStepsFromTemplate. 0 if the family has no AssemblyTemplate yet. */
  assemblyStepCount: number;
  /**
   * QCP source items whose linked process code has no counterpart in the new
   * job's route. Reported, never silently dropped — the wizard lists them.
   */
  unmatchedQcpProcessCodes: string[];
}

export async function createJob(actor: Actor, input: CreateJobInput): Promise<CreateJobResult> {
  const parsed = createJobSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    // ── Validate everything before writing anything ──────────────────────
    const duplicate = await tx.job.findFirst({
      where: { tenantId: actor.tenantId, jobNumber: parsed.jobNumber },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppError(ERROR_CODES.DUPLICATE_JOB_NUMBER, {
        jobNumber: parsed.jobNumber,
        existingJobId: duplicate.id,
      });
    }

    const client = await tx.client.findFirst({
      where: { id: parsed.clientId, tenantId: actor.tenantId },
    });
    if (!client) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Client", clientId: parsed.clientId });

    const family = await tx.productFamily.findFirst({
      where: { id: parsed.familyId, tenantId: actor.tenantId },
    });
    if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId: parsed.familyId });

    const version = await tx.processTemplateVersion.findFirst({
      where: { id: parsed.templateVersionId, template: { tenantId: actor.tenantId } },
      include: { template: true, processes: true, edges: true },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        entity: "ProcessTemplateVersion",
        templateVersionId: parsed.templateVersionId,
      });
    }
    if (version.status !== "PUBLISHED") {
      // Filtering the dropdown is not enforcement.
      throw new AppError(ERROR_CODES.TEMPLATE_VERSION_NOT_PUBLISHED, {
        templateVersionId: version.id,
        status: version.status,
      });
    }
    if (version.template.familyId !== parsed.familyId) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { templateVersionId: version.id, familyId: parsed.familyId },
        "That process route belongs to a different type of equipment.",
      );
    }
    if (version.processes.length === 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { templateVersionId: version.id },
        "That process route has no processes.",
      );
    }

    if (parsed.calendarId != null) {
      const cal = await tx.workCalendar.findFirst({
        where: { id: parsed.calendarId, tenantId: actor.tenantId },
      });
      if (!cal) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "WorkCalendar", calendarId: parsed.calendarId });
    }

    const typeIds = parsed.equipments
      .map((e) => e.equipmentTypeId)
      .filter((x): x is number => x != null);
    if (typeIds.length > 0) {
      const types = await tx.equipmentTypeRef.findMany({
        where: { id: { in: typeIds }, tenantId: actor.tenantId },
      });
      if (types.length !== new Set(typeIds).size) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "EquipmentTypeRef", equipmentTypeIds: typeIds });
      }
      const wrongFamily = types.filter((t) => t.familyId !== parsed.familyId);
      if (wrongFamily.length > 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          { equipmentTypeCodes: wrongFamily.map((t) => t.code) },
          "An equipment type does not belong to this job's type of equipment.",
        );
      }
    }

    const templateCodes = new Set(version.processes.map((p) => p.code));
    const unknownExclusions = parsed.excludedProcessCodes.filter((c) => !templateCodes.has(c));
    if (unknownExclusions.length > 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        entity: "TemplateProcess",
        processCodes: unknownExclusions,
      });
    }

    const specs = parsed.specs ? validateSpecs(family.code, parsed.specs) : null;

    // ── Write ────────────────────────────────────────────────────────────
    return audited(tx, actor, async () => {
      const job = await tx.job.create({
        data: {
          tenantId: actor.tenantId,
          // Opaque id for client-facing URLs — sequential ids leak order volume.
          publicId: randomUUID(),
          clientId: parsed.clientId,
          familyId: parsed.familyId,
          templateVersionId: version.id,
          calendarId: parsed.calendarId,
          jobNumber: parsed.jobNumber,
          clientOrderNo: parsed.clientOrderNo,
          projectName: parsed.projectName,
          poRef: parsed.poRef,
          designCode: parsed.designCode,
          orderDate: parsed.orderDate,
          committedDeliveryDate: parsed.committedDeliveryDate,
          targetDispatchDate: parsed.targetDispatchDate,
          priority: parsed.priority,
          remarks: parsed.remarks,
          specs: specs === null ? undefined : (specs as never),
        },
      });

      const excluded = new Set(parsed.excludedProcessCodes);
      await tx.jobProcess.createMany({
        data: version.processes.map((tp) => ({
          jobId: job.id,
          templateProcessId: tp.id,
          seq: tp.seq,
          code: tp.code,
          name: tp.name,
          departmentId: tp.defaultDepartmentId,
          durationMinDays: tp.durationMinDays,
          durationMaxDays: tp.durationMaxDays,
          envelopeFinishByMinDays: tp.envelopeFinishByMinDays,
          envelopeFinishByMaxDays: tp.envelopeFinishByMaxDays,
          envelopeStartByMinDays: tp.envelopeStartByMinDays,
          envelopeStartByMaxDays: tp.envelopeStartByMaxDays,
          workOrderStages: tp.workOrderStages,
          provisional: tp.provisional,
          included: !excluded.has(tp.code),
        })),
      });

      const jobProcesses = await tx.jobProcess.findMany({
        where: { jobId: job.id },
        select: { id: true, code: true },
      });
      const jpIdByCode = new Map(jobProcesses.map((p) => [p.code, p.id]));
      const tpCodeById = new Map(version.processes.map((p) => [p.id, p.code]));

      // Edges are copied for ALL processes, including excluded ones.
      // lib/schedule/exclude.ts::bypassExcluded splices an excluded node out by
      // composing lag = lagPX + duration(X) + lagXS across it, so an excluded
      // process must keep both its edges and its durations. Dropping either
      // would treat it as taking zero days and drag every successor early —
      // that function's own comment calls this invariant #10 territory.
      await tx.jobProcessEdge.createMany({
        data: version.edges.map((e) => ({
          processId: jpIdByCode.get(tpCodeById.get(e.processId)!)!,
          predecessorId: jpIdByCode.get(tpCodeById.get(e.predecessorId)!)!,
          type: e.type,
          lagDays: e.lagDays,
        })),
      });

      await notifyJobCreated(
        tx,
        actor,
        { id: job.id, jobNumber: job.jobNumber, projectName: job.projectName },
        version.processes.map((tp) => tp.defaultDepartmentId),
      );

      let unitCount = 0;
      let firstEquipmentId: number | null = null;
      const unitIds: number[] = [];
      for (const block of parsed.equipments) {
        const equipment = await tx.equipment.create({
          data: {
            jobId: job.id,
            equipmentTypeId: block.equipmentTypeId,
            name: block.name,
            blockNo: block.blockNo,
            remarks: block.remarks,
          },
        });
        firstEquipmentId ??= equipment.id;
        const units = await tx.unit.createManyAndReturn({
          data: block.serials.map((serialNo) => ({ equipmentId: equipment.id, serialNo, jobId: job.id })),
          select: { id: true },
        });
        unitIds.push(...units.map((u) => u.id));
        unitCount += block.serials.length;
      }

      const qcp = parsed.qcpTemplateSourceId
        ? await cloneQcpTemplate(tx, parsed.qcpTemplateSourceId, job.id, jpIdByCode, actor.tenantId)
        : { qcpTemplateId: null, itemCount: 0, unmatchedProcessCodes: [] as string[] };

      const bom =
        parsed.copyBomFromEquipmentId != null && firstEquipmentId != null
          ? await copyBom(tx, parsed.copyBomFromEquipmentId, firstEquipmentId, actor.tenantId, job.id)
          : { count: 0, createdIds: [] };

      const components =
        bom.createdIds.length > 0 && firstEquipmentId != null
          ? await materializeComponentsFromBomItems(tx, parsed.familyId, firstEquipmentId, bom.createdIds, job.id)
          : { componentCount: 0, skippedNoRoute: 0 };

      const assembly = await materializeAssemblyStepsFromTemplate(
        tx,
        actor.tenantId,
        job.id,
        parsed.familyId,
        unitIds,
        qcp.qcpTemplateId,
      );

      const result: CreateJobResult = {
        jobId: job.id,
        publicId: job.publicId,
        processCount: version.processes.length,
        edgeCount: version.edges.length,
        unitCount,
        qcpItemCount: qcp.itemCount,
        bomItemCount: bom.count,
        componentCount: components.componentCount,
        assemblyStepCount: assembly.stepCount,
        unmatchedQcpProcessCodes: qcp.unmatchedProcessCodes,
      };

      return {
        result,
        audit: {
          action: "job.create",
          entityType: "Job",
          entityId: job.id,
          after: {
            jobNumber: job.jobNumber,
            clientId: job.clientId,
            familyId: job.familyId,
            templateVersionId: job.templateVersionId,
            committedDeliveryDate: job.committedDeliveryDate,
            targetDispatchDate: job.targetDispatchDate,
            processCount: result.processCount,
            equipmentCount: parsed.equipments.length,
            unitCount: result.unitCount,
            bomItemCount: result.bomItemCount,
            componentCount: result.componentCount,
            assemblyStepCount: result.assemblyStepCount,
            excludedProcessCodes: parsed.excludedProcessCodes,
          },
          eventType: "JobCreated",
          eventPayload: { jobId: job.id, jobNumber: job.jobNumber, familyId: job.familyId },
        },
      };
    });
  });
}

/**
 * Set/change an existing job's planning dates (order/committed/target
 * dispatch) after creation. A freshly created job commonly has none of these
 * set — createJob() deliberately doesn't require them (see the note on
 * scheduleNewJobAction) — so this is the only way to give the scheduler
 * something to anchor on afterwards. Same role gate as createJob: a client
 * user never edits these, and the app enforces it here, not just in the UI.
 */
export async function updateJobDates(actor: Actor, input: UpdateJobDatesInput) {
  const parsed = updateJobDatesSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const before = await tx.job.findFirst({
      where: { id: parsed.jobId, tenantId: actor.tenantId },
      select: { orderDate: true, committedDeliveryDate: true, targetDispatchDate: true },
    });
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId: parsed.jobId });

    return audited(tx, actor, async () => {
      const job = await tx.job.update({
        where: { id: parsed.jobId },
        data: {
          orderDate: parsed.orderDate,
          committedDeliveryDate: parsed.committedDeliveryDate,
          targetDispatchDate: parsed.targetDispatchDate,
        },
      });

      return {
        result: {
          jobId: job.id,
          orderDate: job.orderDate,
          committedDeliveryDate: job.committedDeliveryDate,
          targetDispatchDate: job.targetDispatchDate,
        },
        audit: {
          action: "job.update_dates",
          entityType: "Job",
          entityId: job.id,
          before,
          after: {
            orderDate: job.orderDate,
            committedDeliveryDate: job.committedDeliveryDate,
            targetDispatchDate: job.targetDispatchDate,
          },
          eventType: "JobDatesUpdated",
          eventPayload: { jobId: job.id },
        },
      };
    });
  });
}

/**
 * Revise a job's own descriptive/reference fields (client PO, project name,
 * design code, priority, remarks) after creation. Same role gate and direct-
 * update-plus-audit-log pattern as updateJobDates — a plain correction, not a
 * versioned one (invariant #6's "new version with a reason" is for records
 * with real-world consequences already logged elsewhere, e.g. a submitted MTC;
 * these fields carry none of that).
 */
export async function updateJobDetails(actor: Actor, input: UpdateJobDetailsInput) {
  const parsed = updateJobDetailsSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const before = await tx.job.findFirst({
      where: { id: parsed.jobId, tenantId: actor.tenantId },
      select: { clientOrderNo: true, projectName: true, poRef: true, designCode: true, priority: true, remarks: true },
    });
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId: parsed.jobId });

    return audited(tx, actor, async () => {
      const job = await tx.job.update({
        where: { id: parsed.jobId },
        data: {
          clientOrderNo: parsed.clientOrderNo,
          projectName: parsed.projectName,
          poRef: parsed.poRef,
          designCode: parsed.designCode,
          priority: parsed.priority,
          remarks: parsed.remarks,
        },
      });

      return {
        result: {
          jobId: job.id,
          clientOrderNo: job.clientOrderNo,
          projectName: job.projectName,
          poRef: job.poRef,
          designCode: job.designCode,
          priority: job.priority,
          remarks: job.remarks,
        },
        audit: {
          action: "job.update_details",
          entityType: "Job",
          entityId: job.id,
          before,
          after: {
            clientOrderNo: job.clientOrderNo,
            projectName: job.projectName,
            poRef: job.poRef,
            designCode: job.designCode,
            priority: job.priority,
            remarks: job.remarks,
          },
          eventType: "JobDetailsUpdated",
          eventPayload: { jobId: job.id },
        },
      };
    });
  });
}

/**
 * S19: `Job.status` had no writer anywhere in `src/` — every real job sits
 * at the DB default `ACTIVE` forever, which makes `job-health.ts`'s own
 * `CANCELLED`/`COMPLETE`/`ON_HOLD` branches dead code in practice. Same role
 * gate as `updateJobDates`/`updateJobDetails`.
 *
 * Guards only the COMPLETE transition: refuses if any `ProcessPlan` on the
 * job's CURRENT `ScheduleRun`(s) — `isCurrent: true`, scoped per equipment
 * since a multi-equipment job can carry more than one — is not itself
 * COMPLETE. Excluded processes never get a `ProcessPlan` row at all
 * (`envelope.ts` filters them out), so they need no special-casing here.
 * ACTIVE/ON_HOLD/CANCELLED carry no such guard — pausing or cancelling a job
 * with open work is a real, unguarded management decision, not a data-
 * integrity question the way "complete" is.
 */
export async function setJobStatus(actor: Actor, input: SetJobStatusInput): Promise<{ jobId: number; status: string }> {
  const { jobId, status } = setJobStatusSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      select: { id: true, status: true },
    });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });
    if (job.status === status) return { jobId: job.id, status: job.status }; // no-op, nothing to audit

    if (status === "COMPLETE") {
      const incomplete = await tx.processPlan.count({
        where: { scheduleRun: { jobId, isCurrent: true }, status: { not: "COMPLETE" } },
      });
      if (incomplete > 0) {
        throw new AppError(ERROR_CODES.JOB_HAS_INCOMPLETE_PLANS, { jobId, incompletePlanCount: incomplete });
      }
    }

    return audited(tx, actor, async () => {
      const updated = await tx.job.update({ where: { id: jobId }, data: { status } });
      return {
        result: { jobId: updated.id, status: updated.status },
        audit: {
          action: "job.setStatus",
          entityType: "Job",
          entityId: jobId,
          before: { status: job.status },
          after: { status: updated.status },
          eventType: "JobStatusChanged",
          eventPayload: { jobId, from: job.status, to: updated.status },
        },
      };
    });
  });
}

/**
 * Deep-copy a QCP template onto a new job: parties, items, party codes, and
 * the item→process links rebuilt by matching process CODE (not id).
 *
 * Code-matching is what makes this safe across template versions: if the
 * source QCP was built against a route where a process has since been
 * renumbered, the code still resolves. A code with no counterpart is
 * collected and returned, never silently dropped.
 *
 * QcpExecution rows are NOT copied — those are the source job's actual
 * inspection results.
 */
async function cloneQcpTemplate(
  tx: Tx,
  sourceId: number,
  jobId: number,
  jpIdByCode: Map<string, number>,
  tenantId: number,
): Promise<{ qcpTemplateId: number; itemCount: number; unmatchedProcessCodes: string[] }> {
  const source = await tx.qcpTemplate.findFirst({
    // Anchored through job → tenant: qcp_templates is a job-child with no
    // tenant_id of its own, so a bare findUnique would happily return another
    // tenant's row (the ProcessPlan lesson in _shared.ts).
    where: {
      id: sourceId,
      OR: [{ job: { tenantId } }, { jobId: null }],
    },
    include: {
      parties: true,
      items: {
        include: {
          partyCodes: true,
          processLinks: { include: { jobProcess: { select: { code: true } } } },
        },
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!source) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "QcpTemplate", qcpTemplateId: sourceId });

  const copy = await tx.qcpTemplate.create({
    data: {
      jobId,
      jobLabel: source.jobLabel,
      vessel: source.vessel,
      revision: source.revision,
      designCode: source.designCode,
    },
  });

  const partyIdMap = new Map<number, number>();
  for (const p of source.parties) {
    const created = await tx.inspectionParty.create({
      data: { qcpTemplateId: copy.id, jobId, code: p.code, name: p.name },
    });
    partyIdMap.set(p.id, created.id);
  }

  const unmatched = new Set<string>();
  for (const item of source.items) {
    const created = await tx.qcpItem.create({
      data: {
        qcpTemplateId: copy.id,
        jobId,
        sequence: item.sequence,
        srNo: item.srNo,
        kind: item.kind,
        section: item.section,
        activity: item.activity,
        characteristic: item.characteristic,
        extentOfCheck: item.extentOfCheck,
        applicableDocument: item.applicableDocument,
        acceptanceCriteria: item.acceptanceCriteria,
        record: item.record,
        remarks: item.remarks,
      },
    });

    // C7: a from-scratch-authored library item has no real processLinks yet
    // (there was no Job/JobProcess to link against at authoring time) — it
    // carries libraryProcessCodes instead. Falls back to those ONLY when
    // processLinks is empty, so a cloned-from-a-real-job item (today's only
    // path) is completely unaffected.
    const codes =
      item.processLinks.length > 0 ? item.processLinks.map((l) => l.jobProcess.code) : item.libraryProcessCodes;

    for (const pc of item.partyCodes) {
      const newPartyId = partyIdMap.get(pc.inspectionPartyId);
      if (newPartyId == null) continue;
      await tx.qcpItemPartyCode.create({
        data: {
          qcpItemId: created.id,
          jobId,
          inspectionPartyId: newPartyId,
          qcpCodeId: pc.qcpCodeId,
        },
      });
    }

    for (const code of codes) {
      const newJobProcessId = jpIdByCode.get(code);
      if (newJobProcessId == null) {
        unmatched.add(code);
        continue;
      }
      await tx.qcpItemProcess.create({
        data: { qcpItemId: created.id, jobProcessId: newJobProcessId, jobId },
      });
    }
  }

  return { qcpTemplateId: copy.id, itemCount: source.items.length, unmatchedProcessCodes: [...unmatched] };
}

/**
 * Copy BOM lines from an existing equipment into a new one.
 *
 * Deliberately copies ONLY the BomItem rows. Procurement, MaterialIdentification,
 * Component and ItemTest are execution records belonging to the source job —
 * heat numbers, MTC references, PO numbers. Copying them would fabricate
 * traceability, which is the opposite of what this system exists for.
 * `bomRevisionId` is also deliberately left null on the copy — a separate,
 * already-flagged gap (B3 create-path), not this fix's job.
 *
 * Fix wave (Important #4): preserves `parentBomItemId` hierarchies, which
 * B4 (Dispatch 8) made the first real writer of. `createMany` can't point a
 * self-referencing FK at a row created in the same batch, so this is a
 * two-pass copy: pass 1 creates every row with `parentBomItemId` left null,
 * tracking a source-id -> target-id map keyed by `itemNo` (the CSV's stable
 * business key, unlike an autoincrement id which obviously can't survive a
 * copy); pass 2, in the same transaction, sets each copy's `parentBomItemId`
 * to the mapped target id wherever the source had one. Without this, a
 * sub-assembly's exploded required qty on the new job silently drops a
 * multiplication level (e.g. child qtyPer 4 under a parent qtyPer 2 becomes
 * `4 x unitCount` instead of `4 x 2 x unitCount`) — wrong for shortage/kit-
 * gating purposes.
 */
async function copyBom(
  tx: Tx,
  sourceEquipmentId: number,
  targetEquipmentId: number,
  tenantId: number,
  jobId: number,
): Promise<{ count: number; createdIds: number[] }> {
  const source = await tx.equipment.findFirst({
    where: { id: sourceEquipmentId, job: { tenantId } },
    include: { bomItems: { orderBy: { itemNo: "asc" } } },
  });
  if (!source) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Equipment", equipmentId: sourceEquipmentId });
  }
  if (source.bomItems.length === 0) return { count: 0, createdIds: [] };

  const created = await tx.bomItem.createManyAndReturn({
    data: source.bomItems.map((b) => ({
      equipmentId: targetEquipmentId,
      jobId,
      itemNo: b.itemNo,
      blockNo: b.blockNo,
      partName: b.partName,
      description: b.description,
      material: b.material,
      sourceQty: b.sourceQty,
      qtyPer: b.qtyPer,
      uom: b.uom,
      unit: b.unit,
      componentTypeId: b.componentTypeId,
      remarks: b.remarks,
    })),
    select: { id: true, itemNo: true },
  });

  const targetIdByItemNo = new Map(created.map((c) => [c.itemNo, c.id]));
  const sourceItemNoById = new Map(source.bomItems.map((b) => [b.id, b.itemNo]));

  for (const b of source.bomItems) {
    if (b.parentBomItemId == null) continue;
    const parentItemNo = sourceItemNoById.get(b.parentBomItemId);
    const targetParentId = parentItemNo != null ? targetIdByItemNo.get(parentItemNo) : undefined;
    const targetChildId = targetIdByItemNo.get(b.itemNo);
    if (targetParentId == null || targetChildId == null) continue; // defensive: shouldn't happen, source's own FK is internally consistent
    await tx.bomItem.update({ where: { id: targetChildId }, data: { parentBomItemId: targetParentId } });
  }

  return { count: source.bomItems.length, createdIds: created.map((c) => c.id) };
}
