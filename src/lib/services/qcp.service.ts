import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  recordQcpExecutionSchema,
  approveQcpWaiverSchema,
  createQcpTemplateLibrarySchema,
  addQcpItemToLibraryTemplateSchema,
  type RecordQcpExecutionInput,
  type ApproveQcpWaiverInput,
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
  args: { qcpItemId: number; unitId: number; result: QcpExecutionResult; remarks?: string | null; jobId: number },
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
      jobId: args.jobId,
      // recordedAt: DB default now() (invariant #1).
    },
  });
}

/**
 * Minimal QCP checkpoint execution (CLAUDE.md invariant #4). Recording an
 * ACCEPTED result for a unit clears a blocking hold point so the owning
 * process may complete; REJECTED leaves it open (the rework signal).
 *
 * NA (AUD-003) is a *pending waiver*, not a clearance: it is refused outright
 * at submission time — before any write — if the item carries a blocking
 * code that is not `waivable` (a hydrotest witness point, a final
 * inspection). If every blocking code on the item is waivable (or there is
 * no blocking code at all), the NA is recorded exactly as before, but with
 * `waiverApprovedBy` left null — `approveQcpWaiver` below is the only thing
 * that can turn it into an actual clearance, and only a Production Head/Admin
 * may call it. This gives the audit trail two separate actors and two
 * separate timestamps (QC flags, PH signs off) instead of collapsing both
 * into one QC act.
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

    // AUD-077 (12_SECURITY_RBAC.md §6): qcpItemId was taken as given and
    // never checked against the unit's own job — a QcpItem from a different
    // job (same tenant) could be recorded against this unit, polluting the
    // inspection record. QcpItem.jobId is the H1 backstop column, already
    // denormalized from qcpTemplate.jobId by the only two real writers
    // (job-intake.service.ts's cloneQcpTemplate, scripts/h1-backfill-job-ids.ts)
    // — null there means a genuine library item (never linked into any job's
    // processes), which can never legitimately match a real unit.jobId.
    // Same pattern as dispatch.service.ts's addUnitToBatch.
    const qcpItem = await tx.qcpItem.findFirst({ where: { id: qcpItemId }, select: { jobId: true } });
    if (!qcpItem) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "QcpItem", qcpItemId });
    if (qcpItem.jobId !== unit.jobId) {
      throw new AppError(ERROR_CODES.CROSS_JOB_ASSIGNMENT, {
        qcpItemId,
        qcpItemJobId: qcpItem.jobId,
        unitId,
        unitJobId: unit.jobId,
      });
    }

    if (result === "NA") {
      const partyCodes = await tx.qcpItemPartyCode.findMany({
        where: { qcpItemId },
        select: { qcpCode: { select: { blocksCompletion: true, waivable: true } } },
      });
      const hasNonWaivableBlock = partyCodes.some((pc) => pc.qcpCode.blocksCompletion && !pc.qcpCode.waivable);
      if (hasNonWaivableBlock) {
        throw new AppError(ERROR_CODES.QCP_CODE_NOT_WAIVABLE, { qcpItemId, unitId });
      }
    }

    return audited(tx, actor, async () => {
      const exec = await recordQcpExecutionTx(tx, actor, { qcpItemId, unitId, result, remarks, jobId: unit.jobId });
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

/**
 * AUD-003 step two: Production Head/Admin approves a pending NA waiver,
 * stamping `waiverApprovedBy`. Only after this stamp do
 * `assertNoOpenHoldPoint`/`assertUnitHasNoOpenHoldPoint` (_shared.ts) treat
 * the checkpoint as cleared — an unapproved NA still blocks, identically to
 * PENDING/REJECTED.
 *
 * Maker-checker (#3) is deliberately not enforced between the QC submitter
 * and the approving Production Head here — see `recordQcpExecution`'s own
 * comment: that rule sits on process verify, not on the execution itself.
 */
export async function approveQcpWaiver(actor: Actor, input: ApproveQcpWaiverInput): Promise<QcpExecution> {
  const { qcpItemId, unitId } = approveQcpWaiverSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const unit = await tx.unit.findFirst({
      where: { id: unitId, equipment: { job: { tenantId: actor.tenantId } } },
    });
    if (!unit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Unit", unitId });

    // Latest attempt for this (item, unit) — same "latest wins" convention
    // as assertNoOpenHoldPoint's own resolution.
    const latest = await tx.qcpExecution.findFirst({
      where: { qcpItemId, unitId },
      orderBy: { attemptNo: "desc" },
    });
    if (!latest || latest.result !== "NA") {
      throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, { qcpItemId, unitId, actual: latest?.result ?? null });
    }
    if (latest.waiverApprovedBy != null) {
      throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, { qcpItemId, unitId, reason: "already approved" });
    }

    return audited(tx, actor, async () => {
      const updated = await tx.qcpExecution.update({
        where: { id: latest.id },
        data: { waiverApprovedBy: actor.userId },
      });
      return {
        result: updated,
        audit: {
          action: "qcp.waiver_approve",
          entityType: "QcpExecution",
          entityId: updated.id,
          after: { qcpItemId, unitId, waiverApprovedBy: actor.userId },
          eventType: "QcpWaiverApproved",
          eventPayload: { qcpItemId, unitId },
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
// AUD-078 (closed): QcpTemplate/InspectionParty/QcpItem/QcpItemPartyCode all
// carry a real, NOT NULL tenantId now. A library row (jobId null) is
// tenant-owned by whoever authored it — createQcpTemplateLibrary sets it
// from actor.tenantId, and every read/lookup below matches on it directly
// instead of falling open on `jobId: null`.

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
          tenantId: actor.tenantId,
          jobLabel,
          vessel,
          designCode: designCode ?? null,
          parties: { create: parties.map((p) => ({ code: p.code, name: p.name ?? null, tenantId: actor.tenantId })) },
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
    const template = await tx.qcpTemplate.findFirst({
      where: { id: parsed.qcpTemplateId, tenantId: actor.tenantId },
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

    const resolvedPartyCodes: Array<{ inspectionPartyId: number; qcpCodeId: number; tenantId: number }> = [];
    for (const pc of parsed.partyCodes) {
      const party =
        (await tx.inspectionParty.findFirst({
          where: { qcpTemplateId: template.id, code: pc.partyCode },
        })) ??
        // H1: library-authoring path (template.jobId === null, asserted
        // above) — leave jobId unset. InspectionParty stays nullable in
        // Task 3 for exactly this reason; do not backfill a job id here.
        (await tx.inspectionParty.create({
          data: { qcpTemplateId: template.id, code: pc.partyCode, name: null, tenantId: actor.tenantId },
        }));
      const qcpCode = await tx.qcpCodeRef.findFirst({
        where: { tenantId: actor.tenantId, code: pc.qcpCode },
      });
      if (!qcpCode) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "QcpCodeRef", code: pc.qcpCode });
      }
      resolvedPartyCodes.push({ inspectionPartyId: party.id, qcpCodeId: qcpCode.id, tenantId: actor.tenantId });
    }

    return audited(tx, actor, async () => {
      // H1: library-authoring path (template.jobId === null, asserted
      // above) — leave jobId unset. QcpItem stays nullable in Task 3 for
      // exactly this reason; do not backfill a job id here.
      const created = await tx.qcpItem.create({
        data: {
          qcpTemplateId: template.id,
          tenantId: actor.tenantId,
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
