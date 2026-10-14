import { withTenant, type Tx } from "@/lib/db";
import { assertNotClientUser, hasRole, requireRole, ROLES, type Actor } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  editPartFamilySchema,
  partFamilyIdSchema,
  revisePartFamilySchema,
  saveRouteDraftSchema,
  setMaterialStatusSchema,
  upsertMaterialGradeSchema,
  type EditPartFamilyInput,
  type PartFamilyIdInput,
  type RevisePartFamilyInput,
  type SaveRouteDraftInput,
  type SetMaterialStatusInput,
  type UpsertMaterialGradeInput,
} from "@/lib/shared/schemas";
import { loadHeStageMap } from "./master-import.he";
import { loadReferenceData } from "./master-import.service";
import { checkStep, type IssueCode, type NormalStep, type Scope } from "./master-import.rules";
import { evaluateReadiness, fieldsOf, type Finding, type Readiness } from "./master-data.readiness";
import { loadVariants, routeSignature, writeRouteVariant, type RouteCtx } from "./master-data.routes";

/**
 * Lean Core M3 — master-data mutations (part families, routes, grades).
 *
 *   edit / mark reviewed : ADMIN, PRODUCTION_HEAD, ENGINEERING
 *   approve              : PRODUCTION_HEAD only. The last editor is the
 *                          "preparer"; the single Production Head may approve
 *                          his own edits, flagged as self-approved (13 Oct)
 *   an APPROVED record is not edited in place: `revise` (with a reason) puts it
 *   back to DRAFT while its last PUBLISHED route stays in use.
 *
 * Every mutation writes its audit row in the same transaction (invariant 5).
 * Jobs copy master data at release, so nothing here changes a running job.
 */
export const MASTER_DATA_EDIT_ROLES = [ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.ENGINEERING] as const;
export const MASTER_DATA_READ_ROLES = [ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.ENGINEERING, ROLES.PLANNER] as const;

/** Findings that make a DRAFT unsavable (they would not even be valid rows). Completeness gaps are saved and block approval. */
const STRUCTURAL: ReadonlySet<string> = new Set<IssueCode>(["UNKNOWN_OPERATION", "UNKNOWN_DEPARTMENT", "UNKNOWN_STAGE_NUMBER"]);

async function dbNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  return rows[0].now;
}

async function lockedPart(tx: Tx, tenantId: number, partFamilyId: number) {
  await tx.$queryRaw`SELECT id FROM part_families WHERE id = ${partFamilyId} AND tenant_id = ${tenantId} FOR UPDATE`;
  const part = await tx.partFamily.findFirst({
    where: { id: partFamilyId, tenantId },
    include: { componentType: { select: { id: true, code: true, name: true } }, rawForm: { select: { code: true } } },
  });
  if (!part) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "PartFamily", partFamilyId });
  return part;
}

async function routeContext(tx: Tx, tenantId: number): Promise<{ ctx: RouteCtx; ref: Awaited<ReturnType<typeof loadReferenceData>>; heStages: Map<number, { department: string }> }> {
  const [ref, heStages, operations, departments, families] = await Promise.all([
    loadReferenceData(tx, tenantId),
    loadHeStageMap(tx, tenantId),
    tx.operationRef.findMany({ where: { tenantId }, select: { id: true, code: true } }),
    tx.department.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    tx.productFamily.findMany({ where: { tenantId, code: { in: ["PRESSURE_VESSEL", "HEAT_EXCHANGER"] } }, select: { id: true, code: true } }),
  ]);
  return {
    ref,
    heStages,
    ctx: {
      tenantId,
      operationId: new Map(operations.map((o) => [o.code, o.id])),
      departmentId: new Map(departments.map((d) => [d.name, d.id])),
      pvFamilyId: families.find((f) => f.code === "PRESSURE_VESSEL")?.id,
      heFamilyId: families.find((f) => f.code === "HEAT_EXCHANGER")?.id,
    },
  };
}

function guardEdit(actor: Actor): void {
  assertNotClientUser(actor);
  requireRole(actor, ...MASTER_DATA_EDIT_ROLES);
}

function refuseApproved(status: string, what: string): void {
  if (status === "APPROVED") throw new AppError(ERROR_CODES.REVISE_REQUIRED, { what });
}

// ── Part family ──────────────────────────────────────────────────────────

/** DRAFT → REVIEWED: someone other than the author has checked it. */
export async function setPartFamilyReviewed(actor: Actor, input: PartFamilyIdInput): Promise<void> {
  const { partFamilyId } = partFamilyIdSchema.parse(input);
  guardEdit(actor);
  return withTenant(actor.tenantId, async (tx) => {
    const part = await lockedPart(tx, actor.tenantId, partFamilyId);
    if (part.status !== "DRAFT") {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: `Only a draft can be marked reviewed; this one is ${part.status}.` });
    }
    if (part.preparedById != null && part.preparedById === actor.userId) {
      throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { reason: "The person who last edited a part cannot mark it reviewed." });
    }
    await tx.partFamily.update({ where: { id: part.id }, data: { status: "REVIEWED" } });
    await recordAudit(tx, actor, {
      action: "masterData.partFamily.review",
      entityType: "PartFamily",
      entityId: part.id,
      before: { status: part.status },
      after: { status: "REVIEWED", code: part.componentType.code },
    });
  });
}

export interface ApproveResult {
  published: Array<{ variant: string; version: number }>;
  warnings: Finding[];
  /** The approver is also the last person to edit the part. */
  selfApproved: boolean;
}

/** Approve: publishes every DRAFT route variant and stamps the approver. Production Head only. */
export async function approvePartFamily(actor: Actor, input: PartFamilyIdInput): Promise<ApproveResult> {
  const { partFamilyId } = partFamilyIdSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const part = await lockedPart(tx, actor.tenantId, partFamilyId);
    if (part.status === "APPROVED") {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "This part is already approved." });
    }
    // DESPL has one Production Head, so he may approve what he edited himself;
    // that is flagged (audit + detail screen), never silent. Review by someone
    // else is still available and is what makes a second pair of eyes visible.
    const selfApproved = part.preparedById != null && part.preparedById === actor.userId;

    const { ctx, ref, heStages } = await routeContext(tx, actor.tenantId);
    const variants = await loadVariants(tx, actor.tenantId, part.componentTypeId, ctx);
    const readiness = evaluateReadiness(
      { code: part.componentType.code, scope: part.equipmentScope as Scope, routeSource: part.routeSource, makeBuy: part.makeBuy },
      variants,
      ref,
      heStages,
    );
    if (readiness.blockers.length > 0) {
      throw new AppError(ERROR_CODES.APPROVAL_BLOCKED, { blockers: readiness.blockers });
    }

    const published: ApproveResult["published"] = [];
    for (const v of variants.filter((x) => x.status === "DRAFT")) {
      await tx.routeTemplateVersion.update({ where: { id: v.versionId }, data: { status: "PUBLISHED" } });
      await recordAudit(tx, actor, {
        action: "masterData.route.publish",
        entityType: "RouteTemplateVersion",
        entityId: v.versionId,
        before: { status: "DRAFT" },
        after: { status: "PUBLISHED", partCode: part.componentType.code, variant: v.variant, version: v.version },
      });
      published.push({ variant: v.variant, version: v.version });
    }

    const now = await dbNow(tx);
    await tx.partFamily.update({
      where: { id: part.id },
      data: { status: "APPROVED", approvedById: actor.userId, approvedAt: now },
    });
    await recordAudit(tx, actor, {
      action: "masterData.partFamily.approve",
      entityType: "PartFamily",
      entityId: part.id,
      before: { status: part.status },
      after: { status: "APPROVED", code: part.componentType.code, published, selfApproved, reviewed: part.status === "REVIEWED" },
      eventType: "PartFamilyApproved",
      eventPayload: { partFamilyId: part.id, code: part.componentType.code, published, selfApproved },
    });
    return { published, warnings: readiness.warnings, selfApproved };
  });
}

/** APPROVED → DRAFT with a reason; the last PUBLISHED route stays in use until the revision is approved. */
export async function revisePartFamily(actor: Actor, input: RevisePartFamilyInput): Promise<void> {
  const { partFamilyId, reason } = revisePartFamilySchema.parse(input);
  guardEdit(actor);
  return withTenant(actor.tenantId, async (tx) => {
    const part = await lockedPart(tx, actor.tenantId, partFamilyId);
    if (part.status !== "APPROVED") {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Only an approved part needs revising." });
    }
    await tx.partFamily.update({
      where: { id: part.id },
      data: { status: "DRAFT", approvedById: null, approvedAt: null },
    });
    await recordAudit(tx, actor, {
      action: "masterData.partFamily.revise",
      entityType: "PartFamily",
      entityId: part.id,
      before: { status: "APPROVED", approvedById: part.approvedById },
      after: { status: "DRAFT", code: part.componentType.code, reason },
      eventType: "PartFamilyRevised",
      eventPayload: { partFamilyId: part.id, code: part.componentType.code, reason },
    });
  });
}

export async function editPartFamily(actor: Actor, input: EditPartFamilyInput): Promise<void> {
  const { partFamilyId, patch } = editPartFamilySchema.parse(input);
  guardEdit(actor);
  return withTenant(actor.tenantId, async (tx) => {
    const part = await lockedPart(tx, actor.tenantId, partFamilyId);
    refuseApproved(part.status, "part family");

    const { name, ...rest } = patch;
    const data: Record<string, unknown> = { ...rest };
    if (rest.assemblyGroup === "") data.assemblyGroup = null;
    if (part.status === "REVIEWED") data.status = "DRAFT"; // content changed after review
    // The last person to change a part is its preparer, so they cannot also review or approve it.
    data.preparedById = actor.userId;
    if (name !== undefined && name !== part.componentType.name) {
      await tx.componentTypeRef.update({ where: { id: part.componentTypeId }, data: { name } });
    }
    await tx.partFamily.update({ where: { id: part.id }, data });
    await recordAudit(tx, actor, {
      action: "masterData.partFamily.edit",
      entityType: "PartFamily",
      entityId: part.id,
      before: { name: part.componentType.name, status: part.status },
      after: { ...patch, code: part.componentType.code },
    });
  });
}

export interface SaveRouteResult {
  variant: string;
  version: number;
  status: string;
  action: string;
  readiness: Readiness;
}

/**
 * Save one variant's steps as a DRAFT (same version rules as the importer: a
 * DRAFT is replaced in place, a PUBLISHED version gets a new DRAFT). An
 * incomplete draft is allowed; unknown operations, departments or stage
 * numbers are not. Completeness only blocks approval.
 */
export async function saveRouteDraft(actor: Actor, input: SaveRouteDraftInput): Promise<SaveRouteResult> {
  const { partFamilyId, variant, steps, baseSignature } = saveRouteDraftSchema.parse(input);
  guardEdit(actor);

  const seen = new Set<number>();
  for (const s of steps) {
    if (seen.has(s.seq)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "duplicate step number", seq: s.seq });
    seen.add(s.seq);
    if (s.stdTime != null && (s.stdTimeUnit == null || s.stdTimeBasis == null)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "a standard time needs a unit and a basis", seq: s.seq });
    }
    // Relaxations are data defaulting to today's behaviour and are flipped only when
    // their decision is recorded (D3: which items get requiresQc = false is still open).
    if (s.requiresQc === false) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        reason: "Skipping QC for a step is decision D3 and is not enabled yet",
        seq: s.seq,
      });
    }
  }

  return withTenant(actor.tenantId, async (tx) => {
    const part = await lockedPart(tx, actor.tenantId, partFamilyId);
    refuseApproved(part.status, "route");
    const { ctx, ref, heStages } = await routeContext(tx, actor.tenantId);

    // Stale-write guard: the editor sends the signature of the variant it loaded.
    // Without it, two editors on one draft would silently overwrite each other.
    if (baseSignature !== undefined) {
      const current = (await loadVariants(tx, actor.tenantId, part.componentTypeId, ctx)).find((v) => v.variant === variant);
      const have = current ? current.signature : routeSignature([]);
      if (have !== baseSignature) throw new AppError(ERROR_CODES.STALE_WRITE, { variant });
    }

    const normal: NormalStep[] = steps
      .map((s) => ({
        row: 0,
        seq: s.seq,
        operationCode: s.operationCode,
        whatIsDone: s.whatIsDone,
        department: s.department,
        pvStage: s.pvStage,
        heStage: s.heStage,
        stdTime: s.stdTime,
        stdTimeUnit: s.stdTimeUnit,
        stdTimeBasis: s.stdTimeBasis,
        conditional: s.conditional,
        conditionText: s.conditionText,
        acceptanceStandard: s.acceptanceStandard,
        recordDocument: s.recordDocument,
        requiresQc: s.requiresQc,
      }))
      .sort((a, b) => a.seq - b.seq);

    const structural: Finding[] = [];
    for (const s of normal) {
      for (const f of checkStep(
        {
          scope: part.equipmentScope as Scope,
          partCode: part.componentType.code,
          operationLabel: s.operationCode,
          operationCode: s.operationCode,
          department: s.department,
          seqText: String(s.seq),
          pvStage: s.pvStage,
          heStage: s.heStage,
          pvBlank: s.pvStage == null,
          heBlank: s.heStage == null,
        },
        ref,
        heStages,
      )) {
        if (f.severity === "ERROR" && STRUCTURAL.has(f.code)) {
          structural.push({ variant, seq: s.seq, code: f.code, message: f.message, fields: fieldsOf(f.code, f.meta) });
        }
      }
    }
    if (structural.length > 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "some steps are not valid", findings: structural });
    }

    const w = await writeRouteVariant(tx, ctx, {
      typeId: part.componentTypeId,
      variant,
      name: part.componentType.name,
      steps: normal,
      wantStatus: "DRAFT",
    });
    if (w.action !== "unchanged") {
      await tx.partFamily.update({
        where: { id: part.id },
        data: { preparedById: actor.userId, ...(part.status === "REVIEWED" ? { status: "DRAFT" as const } : {}) },
      });
      await recordAudit(tx, actor, {
        action: `masterData.route.${w.action}`,
        entityType: "RouteTemplateVersion",
        entityId: w.versionId!,
        after: { partCode: part.componentType.code, variant, version: w.version, status: w.status, steps: normal.length, stageMappings: w.mappingRows },
      });
    }
    const states = await loadVariants(tx, actor.tenantId, part.componentTypeId, ctx);
    const readiness = evaluateReadiness(
      { code: part.componentType.code, scope: part.equipmentScope as Scope, routeSource: part.routeSource, makeBuy: part.makeBuy },
      states,
      ref,
      heStages,
    );
    return { variant, version: w.version!, status: w.status, action: w.action, readiness };
  });
}

// ── Material grades ──────────────────────────────────────────────────────

export async function upsertMaterialGrade(actor: Actor, input: UpsertMaterialGradeInput): Promise<{ id: number }> {
  const v = upsertMaterialGradeSchema.parse(input);
  guardEdit(actor);
  return withTenant(actor.tenantId, async (tx) => {
    if (v.id == null) {
      const dup = await tx.materialGrade.findFirst({
        where: { tenantId: actor.tenantId, spec: v.spec, grade: v.grade, productForm: v.productForm },
        select: { id: true },
      });
      if (dup) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "this specification, grade and form already exists" });
      const row = await tx.materialGrade.create({
        data: { tenantId: actor.tenantId, spec: v.spec, grade: v.grade, productForm: v.productForm, densityGcc: v.densityGcc, remarks: v.remarks },
      });
      await recordAudit(tx, actor, { action: "masterData.materialGrade.create", entityType: "MaterialGrade", entityId: row.id, after: v });
      return { id: row.id };
    }
    const have = await tx.materialGrade.findFirst({ where: { id: v.id, tenantId: actor.tenantId } });
    if (!have) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "MaterialGrade", id: v.id });
    refuseApproved(have.status, "material grade");
    await tx.materialGrade.update({
      where: { id: have.id },
      data: { spec: v.spec, grade: v.grade, productForm: v.productForm, densityGcc: v.densityGcc, remarks: v.remarks, status: "DRAFT" },
    });
    await recordAudit(tx, actor, {
      action: "masterData.materialGrade.edit",
      entityType: "MaterialGrade",
      entityId: have.id,
      before: { spec: have.spec, grade: have.grade, productForm: have.productForm, densityGcc: have.densityGcc?.toString() ?? null, status: have.status },
      after: v,
    });
    return { id: have.id };
  });
}

/** DRAFT → REVIEWED (edit roles), → APPROVED (Production Head), back to DRAFT from APPROVED/REVIEWED (needs a reason). */
export async function setMaterialStatus(actor: Actor, input: SetMaterialStatusInput): Promise<void> {
  const { materialGradeId, to, reason } = setMaterialStatusSchema.parse(input);
  assertNotClientUser(actor);
  if (to === "APPROVED") requireRole(actor, ROLES.PRODUCTION_HEAD);
  else if (to === "DRAFT") requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);
  else requireRole(actor, ...MASTER_DATA_EDIT_ROLES);

  return withTenant(actor.tenantId, async (tx) => {
    const have = await tx.materialGrade.findFirst({ where: { id: materialGradeId, tenantId: actor.tenantId } });
    if (!have) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "MaterialGrade", id: materialGradeId });
    const allowed: Record<string, string[]> = { REVIEWED: ["DRAFT"], APPROVED: ["DRAFT", "REVIEWED"], DRAFT: ["REVIEWED", "APPROVED"] };
    if (!allowed[to].includes(have.status)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: `A grade that is ${have.status} cannot move to ${to}.` });
    }
    if (to === "DRAFT" && (reason ?? "").length < 5) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "A reason (at least 5 characters) is required to revise an approved or reviewed grade." });
    }
    if (to === "APPROVED" && have.densityGcc == null) {
      throw new AppError(ERROR_CODES.APPROVAL_BLOCKED, { blockers: [{ code: "MISSING_DENSITY", message: "A grade needs a density before it can be approved." }] });
    }
    await tx.materialGrade.update({ where: { id: have.id }, data: { status: to } });
    await recordAudit(tx, actor, {
      action: `masterData.materialGrade.${to === "DRAFT" ? "revise" : to === "REVIEWED" ? "review" : "approve"}`,
      entityType: "MaterialGrade",
      entityId: have.id,
      before: { status: have.status },
      after: { status: to, reason: reason ?? null, hasProductionHead: hasRole(actor, ROLES.PRODUCTION_HEAD) },
    });
  });
}
