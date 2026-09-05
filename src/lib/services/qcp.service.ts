import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  recordQcpExecutionSchema,
  createQcpTemplateLibrarySchema,
  addQcpItemToLibraryTemplateSchema,
  type RecordQcpExecutionInput,
  type CreateQcpTemplateLibraryInput,
  type AddQcpItemToLibraryTemplateInput,
} from "@/lib/shared/schemas";
import type { QcpExecution, QcpExecutionResult, QcpItem, QcpTemplate } from "@/generated/prisma/client";

/**
 * Bare tx-level create, no audit of its own — same discipline as
 * `welding.service.ts`'s `recordNdtResultTx`. Callers already inside a
 * transaction (the public `recordQcpExecution` below, and A4's sync from
 * `assembly.service.ts`'s verify/reject) record their own audit row so the
 * write is never silently un-audited (invariant #5).
 */
export async function recordQcpExecutionTx(
  tx: Tx,
  actor: Actor,
  args: { qcpItemId: number; unitId: number; result: QcpExecutionResult; remarks?: string | null },
): Promise<QcpExecution> {
  // Next attempt number for this (item, unit) — re-inspection after rejection.
  const prior = await tx.qcpExecution.aggregate({
    _max: { attemptNo: true },
    where: { qcpItemId: args.qcpItemId, unitId: args.unitId },
  });
  const attemptNo = (prior._max.attemptNo ?? 0) + 1;

  return tx.qcpExecution.create({
    data: {
      qcpItemId: args.qcpItemId,
      unitId: args.unitId,
      attemptNo,
      result: args.result,
      clearedBy: actor.userId,
      remarks: args.remarks ?? null,
      // recordedAt: DB default now() (invariant #1).
    },
  });
}

/**
 * Minimal QCP checkpoint execution (CLAUDE.md invariant #4). Recording an
 * ACCEPTED/NA result for a unit clears a blocking hold point so the owning
 * process may complete; REJECTED leaves it open (the rework signal). This is
 * the smallest surface that lets per-unit hold points be cleared — TPI
 * call-given/attended and witness-waiver approval stay Phase 2.
 *
 * QC-role-gated: recording an inspection result is inherently a QC act. The
 * maker-checker rule (#3) sits on process verify, not on the execution itself.
 */
export async function recordQcpExecution(
  actor: Actor,
  input: RecordQcpExecutionInput,
): Promise<QcpExecution> {
  const { qcpItemId, unitId, result, remarks } = recordQcpExecutionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC);

  return withTenant(actor.tenantId, async (tx) => {
    // Neither `units` nor `qcp_items` carry tenant_id (audit C3), so a bare
    // id would happily accept another tenant's unit and let this actor clear
    // its blocking hold point. Anchor through `unit.equipment.job`, which IS
    // tenant-scoped — same pattern as `lockProcessPlanForUpdate` (_shared.ts).
    const unit = await tx.unit.findFirst({
      where: { id: unitId, equipment: { job: { tenantId: actor.tenantId } } },
    });
    if (!unit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Unit", unitId });

    return audited(tx, actor, async () => {
      const exec = await recordQcpExecutionTx(tx, actor, { qcpItemId, unitId, result, remarks });
      return {
        result: exec,
        audit: {
          action: "qcp.record",
          entityType: "QcpExecution",
          entityId: exec.id,
          after: { qcpItemId, unitId, attemptNo: exec.attemptNo, result },
          eventType: "QcpExecutionRecorded",
          eventPayload: { qcpItemId, unitId, attemptNo: exec.attemptNo, result },
        },
      };
    });
  });
}

// ── QCP template authoring (C7) ──────────────────────────────────────────
//
// cloneQcpTemplate (job-intake.service.ts) can only COPY an existing
// QcpTemplate. These two functions are the missing from-scratch path: create
// a library row with no items, then add items to it one at a time. Both are
// authoring-only — refused once the target template belongs to a real job,
// where items are managed through that job's own execution flow instead.
//
// Known gap, not this item's job to fix: QcpTemplate/InspectionParty carry no
// tenantId of their own (a job-owned row is anchored through job.tenantId;
// a library row with jobId null has NO tenant anchor in the schema at all).
// cloneQcpTemplate already lives with this (`OR: [{ job: { tenantId } },
// { jobId: null }]`) — every tenant can see and clone every OTHER tenant's
// library rows today. createQcpTemplateLibrary below doesn't relax anything
// further, but it does add more such rows. Fixing it means adding a
// tenantId column to QcpTemplate, a bigger, unscoped migration.

/**
 * Create a brand-new library `QcpTemplate` (jobId: null) plus its
 * `InspectionParty` rows, ready for `addQcpItemToLibraryTemplate` to author
 * items onto.
 */
export async function createQcpTemplateLibrary(
  actor: Actor,
  input: CreateQcpTemplateLibraryInput,
): Promise<QcpTemplate> {
  const { jobLabel, vessel, designCode, parties } = createQcpTemplateLibrarySchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    return audited(tx, actor, async () => {
      const created = await tx.qcpTemplate.create({
        data: {
          jobId: null,
          jobLabel,
          vessel,
          designCode: designCode ?? null,
          parties: { create: parties.map((p) => ({ code: p.code, name: p.name ?? null })) },
        },
      });
      return {
        result: created,
        audit: {
          action: "qcp.template.createLibrary",
          entityType: "QcpTemplate",
          entityId: created.id,
          after: { jobLabel, vessel, designCode: designCode ?? null, partyCodes: parties.map((p) => p.code) },
          eventType: "QcpTemplateLibraryCreated",
          eventPayload: { qcpTemplateId: created.id, jobLabel },
        },
      };
    });
  });
}

/**
 * Add one `QcpItem` to a library template. Refused if the target template
 * already belongs to a job — this path is for library authoring only.
 * `partyCodes[].partyCode` is looked-up-or-created inline on this template
 * (same "author it on the fly" spirit as route authoring's inline
 * `OperationRef` creation) — `qcpCode` must already exist in the tenant's
 * `QcpCodeRef` catalog, since it carries real blocksCompletion/waivable
 * semantics that must not be silently invented per-item.
 */
export async function addQcpItemToLibraryTemplate(
  actor: Actor,
  input: AddQcpItemToLibraryTemplateInput,
): Promise<QcpItem> {
  const parsed = addQcpItemToLibraryTemplateSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    // qcp_templates has no tenant_id of its own — anchored the same way
    // cloneQcpTemplate does (see the file-level note above).
    const template = await tx.qcpTemplate.findFirst({
      where: { id: parsed.qcpTemplateId, OR: [{ job: { tenantId: actor.tenantId } }, { jobId: null }] },
    });
    if (!template) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "QcpTemplate", qcpTemplateId: parsed.qcpTemplateId });
    }
    if (template.jobId !== null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        reason:
          "This QCP template already belongs to a job — items on a live job's QCP are managed through its own execution flow, not this authoring path.",
        qcpTemplateId: template.id,
      });
    }

    const resolvedPartyCodes: Array<{ inspectionPartyId: number; qcpCodeId: number }> = [];
    for (const pc of parsed.partyCodes) {
      const party =
        (await tx.inspectionParty.findFirst({
          where: { qcpTemplateId: template.id, code: pc.partyCode },
        })) ??
        (await tx.inspectionParty.create({
          data: { qcpTemplateId: template.id, code: pc.partyCode, name: null },
        }));
      const qcpCode = await tx.qcpCodeRef.findFirst({
        where: { tenantId: actor.tenantId, code: pc.qcpCode },
      });
      if (!qcpCode) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "QcpCodeRef", code: pc.qcpCode });
      }
      resolvedPartyCodes.push({ inspectionPartyId: party.id, qcpCodeId: qcpCode.id });
    }

    return audited(tx, actor, async () => {
      const created = await tx.qcpItem.create({
        data: {
          qcpTemplateId: template.id,
          sequence: parsed.sequence,
          srNo: parsed.srNo,
          kind: parsed.kind,
          section: parsed.section ?? null,
          activity: parsed.activity,
          characteristic: parsed.characteristic ?? null,
          extentOfCheck: parsed.extentOfCheck ?? null,
          applicableDocument: parsed.applicableDocument ?? null,
          acceptanceCriteria: parsed.acceptanceCriteria ?? null,
          record: parsed.record ?? null,
          remarks: parsed.remarks ?? null,
          libraryProcessCodes: parsed.libraryProcessCodes,
          partyCodes: { create: resolvedPartyCodes },
        },
      });
      return {
        result: created,
        audit: {
          action: "qcp.template.addItem",
          entityType: "QcpItem",
          entityId: created.id,
          after: {
            qcpTemplateId: template.id,
            sequence: parsed.sequence,
            activity: parsed.activity,
            libraryProcessCodes: parsed.libraryProcessCodes,
          },
          eventType: "QcpTemplateItemAdded",
          eventPayload: { qcpTemplateId: template.id, qcpItemId: created.id },
        },
      };
    });
  });
}
