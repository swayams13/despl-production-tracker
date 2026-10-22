import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { ROLES, hasRole, requireRole, assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { FEATURES } from "@/lib/shared/flags";
import { createJobSchema } from "@/lib/shared/schemas";
import { createJobTx, type CreateJobResult } from "./job-intake.service";

/**
 * J7a (Q1): job drafts. A draft is a row in `job_drafts`, not a Job and not a JobStatus value, so no
 * existing reader has to learn about it. The payload is createJobSchema input while it is being
 * made (any part may be missing); `releaseDraft` parses it in full and runs createJobTx.
 *
 * Roles (ratify SJ): ADMIN, PRODUCTION_HEAD and PLANNER save, copy and discard drafts (a planner
 * only their own); only ADMIN and PRODUCTION_HEAD release, because releasing is createJob.
 */

export const DRAFT_ROLES = [ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.PLANNER] as const;
const RELEASE_ROLES = [ROLES.ADMIN, ROLES.PRODUCTION_HEAD] as const;
const MAX_PAYLOAD_BYTES = 512 * 1024;

// Allow-lists come from the schema itself, so a draft can never carry a key createJob would refuse
// (invariant 1: no `actual_*` or `*_at` field gets in through a draft).
const TOP_KEYS = new Set(Object.keys(createJobSchema.shape));
const LINE_KEYS = new Set(Object.keys((createJobSchema.shape.equipments.element as unknown as { shape: object }).shape));

export type DraftPayload = Record<string, unknown>;

export interface JobDraftView {
  id: number;
  status: "DRAFT" | "RELEASED" | "DISCARDED";
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
  sourceJobId: number | null;
  releasedJobId: number | null;
  /** jobNumber, else projectName, else null: what the list shows. */
  label: string | null;
  payload: DraftPayload;
}

function checkPayload(payload: unknown): DraftPayload {
  const bad = (reason: string) => new AppError(ERROR_CODES.VALIDATION_FAILED, { reason }, `This draft cannot be saved: ${reason}.`);
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) throw bad("it must be an object");
  const p = payload as DraftPayload;
  const unknownKey = Object.keys(p).find((k) => !TOP_KEYS.has(k));
  if (unknownKey) throw bad(`"${unknownKey}" is not a job field`);
  if (p.equipments != null) {
    if (!Array.isArray(p.equipments)) throw bad("equipments must be a list");
    for (const line of p.equipments) {
      if (line == null || typeof line !== "object" || Array.isArray(line)) throw bad("each equipment line must be an object");
      const k = Object.keys(line).find((x) => !LINE_KEYS.has(x));
      if (k) throw bad(`"${k}" is not an equipment field`);
    }
  }
  if (JSON.stringify(p).length > MAX_PAYLOAD_BYTES) throw bad("it is too large");
  return p;
}

type Row = { id: number; status: JobDraftView["status"]; createdBy: number; createdAt: Date; updatedAt: Date; sourceJobId: number | null; releasedJobId: number | null; payload: unknown };

function view(r: Row): JobDraftView {
  const payload = (r.payload ?? {}) as DraftPayload;
  const label = [payload.jobNumber, payload.projectName].find((x): x is string => typeof x === "string" && x.length > 0) ?? null;
  return { ...r, payload, label };
}

/** The draft, tenant-scoped by RLS; a planner sees only their own. Locks the row so a double release or save serialises. */
async function lockDraft(tx: Tx, actor: Actor, draftId: number): Promise<Row> {
  await tx.$queryRaw`SELECT id FROM job_drafts WHERE id = ${draftId} FOR UPDATE`;
  const d = await tx.jobDraft.findFirst({ where: { id: draftId, tenantId: actor.tenantId } });
  if (!d || (d.createdBy !== actor.userId && !hasRole(actor, ...RELEASE_ROLES))) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "JobDraft", draftId });
  }
  return d;
}

function assertOpen(d: Row) {
  if (d.status === "RELEASED") throw new AppError(ERROR_CODES.DRAFT_ALREADY_RELEASED, { draftId: d.id, releasedJobId: d.releasedJobId });
  if (d.status === "DISCARDED") throw new AppError(ERROR_CODES.DRAFT_DISCARDED, { draftId: d.id });
}

/** Create a draft (no `draftId`) or replace an open draft's payload. */
export async function saveDraft(actor: Actor, input: { draftId?: number; payload: unknown }): Promise<JobDraftView> {
  assertNotClientUser(actor);
  requireRole(actor, ...DRAFT_ROLES);
  const payload = checkPayload(input.payload);
  return withTenant(actor.tenantId, async (tx) => {
    if (input.draftId == null) {
      return audited(tx, actor, async () => {
        const d = await tx.jobDraft.create({ data: { tenantId: actor.tenantId, createdBy: actor.userId, payload: payload as never } });
        return { result: view(d), audit: { action: "jobDraft.save", entityType: "JobDraft", entityId: d.id, after: { status: d.status, payload } } };
      });
    }
    const before = await lockDraft(tx, actor, input.draftId);
    assertOpen(before);
    return audited(tx, actor, async () => {
      const d = await tx.jobDraft.update({ where: { id: before.id }, data: { payload: payload as never } });
      return { result: view(d), audit: { action: "jobDraft.save", entityType: "JobDraft", entityId: d.id, before: { payload: before.payload }, after: { payload } } };
    });
  });
}

/**
 * Start a draft from a previous job: lines (type, name, answers, route version) with blank serials,
 * the job's QC plan as the source, and each line's BOM and weld map as the per-line copy sources.
 * Dates, job number and order numbers are left for the new order.
 */
export async function copyJobToDraft(actor: Actor, input: { jobId: number }): Promise<JobDraftView> {
  assertNotClientUser(actor);
  requireRole(actor, ...DRAFT_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: input.jobId, tenantId: actor.tenantId },
      include: { equipments: { orderBy: { id: "asc" } }, qcpTemplates: { orderBy: { id: "asc" }, take: 1, select: { id: true } } },
    });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId: input.jobId });

    // Processes the source's planner dropped (not an includeWhen rule: that is re-decided from the new answers).
    const dropped = await tx.jobProcess.findMany({ where: { jobId: job.id, included: false }, select: { code: true, inclusionReason: true } });
    const excludedProcessCodes = [...new Set(dropped.filter((p) => !(p.inclusionReason as { byRule?: boolean } | null)?.byRule).map((p) => p.code))];
    const created = excludedProcessCodes.length
      ? await tx.auditLog.findFirst({ where: { tenantId: actor.tenantId, action: "job.create", entityType: "Job", entityId: String(job.id) }, select: { after: true } })
      : null;
    const exclusionReason = (created?.after as { exclusionReason?: string | null } | null)?.exclusionReason ?? null;

    const payload: DraftPayload = {
      clientId: job.clientId,
      familyId: job.familyId,
      templateVersionId: job.templateVersionId,
      calendarId: job.calendarId,
      designCode: job.designCode,
      priority: job.priority,
      excludedProcessCodes,
      exclusionReason,
      qcpTemplateSourceId: job.qcpTemplates[0]?.id ?? null,
      equipments: job.equipments.map((e) => ({
        equipmentTypeId: e.equipmentTypeId,
        templateVersionId: e.templateVersionId != null && e.templateVersionId !== job.templateVersionId ? e.templateVersionId : null,
        name: e.name,
        blockNo: e.blockNo,
        remarks: e.remarks,
        config: e.config ?? null,
        serials: [],
        copyBomFromEquipmentId: e.id,
        copyWeldMapFromEquipmentId: e.id,
      })),
    };
    return audited(tx, actor, async () => {
      const d = await tx.jobDraft.create({ data: { tenantId: actor.tenantId, createdBy: actor.userId, sourceJobId: job.id, payload: payload as never } });
      return { result: view(d), audit: { action: "jobDraft.copy", entityType: "JobDraft", entityId: d.id, after: { sourceJobId: job.id, jobNumber: job.jobNumber, payload } } };
    });
  });
}

/** Turn a draft into a job, once. Same rules as the wizard: Production Head or Admin, delivery date required, PV only while intake is frozen. */
export async function releaseDraft(actor: Actor, input: { draftId: number }): Promise<{ draftId: number; job: CreateJobResult }> {
  assertNotClientUser(actor);
  requireRole(actor, ...RELEASE_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const d = await lockDraft(tx, actor, input.draftId);
    assertOpen(d);
    const parsed = createJobSchema.parse(d.payload);
    if (!parsed.committedDeliveryDate) throw new AppError(ERROR_CODES.DELIVERY_DATE_REQUIRED);
    if (!FEATURES.multiFamilyIntake) {
      const family = await tx.productFamily.findFirst({ where: { id: parsed.familyId, tenantId: actor.tenantId }, select: { code: true } });
      if (family && family.code !== "PRESSURE_VESSEL") throw new AppError(ERROR_CODES.FEATURE_FROZEN, { feature: "multiFamilyIntake", familyCode: family.code });
    }
    const job = await createJobTx(tx, actor, parsed);
    await audited(tx, actor, async () => {
      await tx.jobDraft.update({ where: { id: d.id }, data: { status: "RELEASED", releasedJobId: job.jobId } });
      return { result: null, audit: { action: "jobDraft.release", entityType: "JobDraft", entityId: d.id, before: { status: d.status }, after: { status: "RELEASED", releasedJobId: job.jobId } } };
    });
    return { draftId: d.id, job };
  });
}

/** Discard is a status, never a delete. A released draft cannot be discarded. */
export async function discardDraft(actor: Actor, input: { draftId: number }): Promise<JobDraftView> {
  assertNotClientUser(actor);
  requireRole(actor, ...DRAFT_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const d = await lockDraft(tx, actor, input.draftId);
    if (d.status === "DISCARDED") return view(d);
    assertOpen(d);
    return audited(tx, actor, async () => {
      const u = await tx.jobDraft.update({ where: { id: d.id }, data: { status: "DISCARDED" } });
      return { result: view(u), audit: { action: "jobDraft.discard", entityType: "JobDraft", entityId: d.id, before: { status: d.status }, after: { status: "DISCARDED" } } };
    });
  });
}

/** Open drafts, newest first: your own; Admin and Production Head see everyone's. */
export async function listDrafts(actor: Actor): Promise<JobDraftView[]> {
  assertNotClientUser(actor);
  requireRole(actor, ...DRAFT_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.jobDraft.findMany({
      where: { tenantId: actor.tenantId, status: "DRAFT", ...(hasRole(actor, ...RELEASE_ROLES) ? {} : { createdBy: actor.userId }) },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(view);
  });
}

export async function loadDraft(actor: Actor, draftId: number): Promise<JobDraftView> {
  assertNotClientUser(actor);
  requireRole(actor, ...DRAFT_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const d = await tx.jobDraft.findFirst({ where: { id: draftId, tenantId: actor.tenantId } });
    if (!d || (d.createdBy !== actor.userId && !hasRole(actor, ...RELEASE_ROLES))) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "JobDraft", draftId });
    return view(d);
  });
}
