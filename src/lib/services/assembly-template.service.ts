import { createHash } from "node:crypto";
import { withTenant, type Tx } from "@/lib/db";
import { assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  isSeamDriven,
  mapAssemblySequence,
  normName,
  sequenceSignature,
  type Collapse,
  type MappedStep,
  type SequenceIssue,
} from "@/lib/shared/assembly-sequence";
import { questionsForLine } from "@/lib/shared/config-questions";
import { parseMasterWorkbook, type ParsedWorkbook } from "./master-import.parse";

/**
 * Lean Core J4c: an equipment type's own assembly sequence as master data.
 *
 *   dry run  : ADMIN, PRODUCTION_HEAD. Reads the workbook's "Assembly Sequence" sheet for one
 *              workbook equipment type, maps it to template steps and reports; writes nothing.
 *   import   : ADMIN, PRODUCTION_HEAD. Writes a DRAFT version on the type's own template (made if
 *              absent). The importer is recorded as the preparer. Identical content writes nothing.
 *   publish  : PRODUCTION_HEAD only, and never the preparer (MAKER_CHECKER_VIOLATION, admins not
 *              exempt). Invariant 9: a published version is never edited; jobs keep the version on
 *              Equipment.assemblyTemplateVersionId, and `resolveAssemblyTemplateVersion` hands the
 *              newest PUBLISHED one to new jobs.
 *
 * assembly_template_versions / _steps carry no tenant column and no RLS of their own: every read
 * here goes through `template: { tenantId }`.
 */
export const ASSEMBLY_IMPORT_ROLES = [ROLES.ADMIN, ROLES.PRODUCTION_HEAD] as const;

export type SequenceOutcome = "NEW_DRAFT" | "UPDATE_DRAFT" | "UNCHANGED_DRAFT" | "UNCHANGED_PUBLISHED";

export interface AssemblySequenceReport {
  equipmentType: { id: number; code: string; name: string };
  /** Every equipment type named on the sheet, with its row count. */
  labels: { label: string; rows: number }[];
  /** The workbook equipment type being read; null until one is chosen. */
  label: string | null;
  needsLabel: boolean;
  rowsRead: number;
  steps: MappedStep[];
  collapses: Collapse[];
  issues: SequenceIssue[];
  errors: number;
  outcome: SequenceOutcome | null;
  /** The newest version this type already has, for the screen. */
  existing: { version: number; status: string } | null;
  fileSha256: string;
  /** Sent back to import: it refuses if the sheet or the reference data changed meanwhile. */
  planFingerprint: string;
}

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

function guard(actor: Actor, roles: readonly string[]): void {
  assertNotClientUser(actor);
  requireRole(actor, ...(roles as never[]));
}

async function dbNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  return rows[0].now;
}

async function loadType(tx: Tx, tenantId: number, equipmentTypeId: number) {
  const type = await tx.equipmentTypeRef.findFirst({ where: { id: equipmentTypeId, tenantId } });
  if (!type) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "EquipmentType", equipmentTypeId });
  return type;
}

async function ownTemplate(tx: Tx, tenantId: number, equipmentTypeId: number) {
  return tx.assemblyTemplate.findFirst({ where: { tenantId, equipmentTypeId } });
}

/** Steps as stored, in the shape the signature compares. */
async function storedSteps(tx: Tx, versionId: number) {
  return tx.assemblyTemplateStep.findMany({ where: { versionId }, orderBy: { seq: "asc" } });
}

async function plan(
  tx: Tx,
  actor: Actor,
  bytes: Buffer,
  wb: ParsedWorkbook,
  input: { equipmentTypeId: number; label?: string | null },
): Promise<AssemblySequenceReport> {
  const type = await loadType(tx, actor.tenantId, input.equipmentTypeId);
  const sheetProblem = wb.problems.find((p) => p.sheet === "Assembly Sequence");
  if (sheetProblem) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: sheetProblem.message });

  const counts = new Map<string, number>();
  for (const r of wb.assembly) if (r.equipmentType) counts.set(r.equipmentType, (counts.get(r.equipmentType) ?? 0) + 1);
  const labels = [...counts.entries()].map(([label, rows]) => ({ label, rows }));
  const wanted = input.label ? normName(input.label) : labels.length === 1 ? normName(labels[0].label) : null;
  const label = wanted ? (labels.find((l) => normName(l.label) === wanted)?.label ?? null) : null;
  if (input.label && !label) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: `The sheet has no rows for "${input.label}".` });
  }

  const base = { equipmentType: { id: type.id, code: type.code, name: type.name }, labels, fileSha256: sha(bytes) };
  const template = await ownTemplate(tx, actor.tenantId, type.id);
  const versions = template
    ? await tx.assemblyTemplateVersion.findMany({ where: { templateId: template.id, template: { tenantId: actor.tenantId } }, orderBy: { version: "desc" } })
    : [];
  const existing = versions[0] ? { version: versions[0].version, status: versions[0].status } : null;
  if (!label) {
    return { ...base, label: null, needsLabel: true, rowsRead: 0, steps: [], collapses: [], issues: [], errors: 0, outcome: null, existing, planFingerprint: sha(`${type.id}|none`) };
  }

  const [departments, route, pressureParts] = await Promise.all([
    tx.department.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, name: true } }),
    loadProcessCodes(tx, actor.tenantId, type.familyId),
    tx.partFamily.findMany({
      where: { tenantId: actor.tenantId, status: "APPROVED", pressureRetaining: true },
      select: { componentType: { select: { code: true } } },
    }),
  ]);
  const rows = wb.assembly.filter((r) => r.equipmentType === label);
  const mapped = mapAssemblySequence(rows, {
    departmentIdByName: new Map(departments.map((d) => [normName(d.name), d.id])),
    processCodes: route,
    pressureParts: new Set(pressureParts.map((p) => p.componentType.code)),
  });
  const issues = [...mapped.issues];

  if (mapped.steps.some(isSeamDriven)) {
    const questions = await tx.configQuestion.findMany({
      where: { tenantId: actor.tenantId, familyId: type.familyId, key: "shell_courses", active: true },
      select: { equipmentTypeId: true },
    });
    if (questionsForLine(questions as never, type.id).length === 0) {
      issues.push({ row: null, severity: "WARNING", code: "NO_SHELL_COURSES_QUESTION", message: "This sequence has welds that follow the shell courses, but this equipment type has no 'Shell courses' question. It can be imported, not published, until it has one." });
    }
  }

  // Same content as the draft in progress, else the published version it would replace.
  const draft = versions.find((v) => v.status === "DRAFT");
  const published = versions.find((v) => v.status === "PUBLISHED");
  const sig = sequenceSignature(mapped.steps);
  const same = async (v: { id: number } | undefined) => !!v && sequenceSignature(await storedSteps(tx, v.id)) === sig;
  const blocked = mapped.issues.some((i) => i.severity === "ERROR");
  const outcome: SequenceOutcome = draft ? ((await same(draft)) ? "UNCHANGED_DRAFT" : "UPDATE_DRAFT") : (await same(published)) ? "UNCHANGED_PUBLISHED" : "NEW_DRAFT";

  return {
    ...base,
    label,
    needsLabel: false,
    rowsRead: rows.length,
    steps: mapped.steps,
    collapses: mapped.collapses,
    issues,
    errors: issues.filter((i) => i.severity === "ERROR").length,
    outcome: blocked ? null : outcome,
    existing,
    planFingerprint: sha(JSON.stringify([type.id, label, sig, outcome, draft?.id ?? null, versions[0]?.version ?? 0])),
  };
}

/** Codes of the family's newest PUBLISHED process route: the processes a step may count toward. */
async function loadProcessCodes(tx: Tx, tenantId: number, familyId: number): Promise<Set<number>> {
  const version = await tx.processTemplateVersion.findFirst({
    where: { status: "PUBLISHED", template: { tenantId, familyId } },
    orderBy: { version: "desc" },
    include: { processes: { select: { code: true } } },
  });
  return new Set((version?.processes ?? []).map((p) => Number(p.code)).filter(Number.isInteger));
}

export async function dryRunAssemblySequence(
  actor: Actor,
  bytes: Buffer,
  input: { equipmentTypeId: number; label?: string | null },
): Promise<AssemblySequenceReport> {
  guard(actor, ASSEMBLY_IMPORT_ROLES);
  const wb = parseMasterWorkbook(bytes); // before the transaction: parsing is not database work
  return withTenant(actor.tenantId, (tx) => plan(tx, actor, bytes, wb, input));
}

export interface ImportResult {
  outcome: SequenceOutcome;
  versionId: number | null;
  version: number | null;
  steps: number;
}

export async function importAssemblySequence(
  actor: Actor,
  bytes: Buffer,
  input: { equipmentTypeId: number; label: string; fileName: string; planFingerprint: string },
): Promise<ImportResult> {
  guard(actor, ASSEMBLY_IMPORT_ROLES);
  const wb = parseMasterWorkbook(bytes);
  return withTenant(actor.tenantId, async (tx) => {
    // One import per type at a time: two would both read "no draft" and make two.
    await tx.$queryRaw`SELECT id FROM equipment_type_refs WHERE id = ${input.equipmentTypeId} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
    const report = await plan(tx, actor, bytes, wb, input);
    if (report.errors > 0 || report.outcome == null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "The sheet has errors; fix them in the workbook and check again.", errors: report.errors });
    }
    if (report.planFingerprint !== input.planFingerprint) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "The workbook or the reference data changed since the check. Check the file again, then import." });
    }
    if (report.outcome === "UNCHANGED_DRAFT" || report.outcome === "UNCHANGED_PUBLISHED") {
      const v = await latestVersion(tx, actor.tenantId, input.equipmentTypeId, report.outcome === "UNCHANGED_DRAFT" ? "DRAFT" : "PUBLISHED");
      return { outcome: report.outcome, versionId: v?.id ?? null, version: v?.version ?? null, steps: report.steps.length };
    }

    const type = await loadType(tx, actor.tenantId, input.equipmentTypeId);
    let template = await ownTemplate(tx, actor.tenantId, type.id);
    template ??= await tx.assemblyTemplate.create({
      data: { tenantId: actor.tenantId, familyId: type.familyId, name: `Assembly sequence (${type.name})`, equipmentTypeId: type.id },
    });
    const notes = `J4c import of "${report.label}" from ${input.fileName} (${report.rowsRead} rows)`;
    let version;
    let replaced: { version: number; steps: number } | null = null;
    if (report.outcome === "UPDATE_DRAFT") {
      version = (await latestVersion(tx, actor.tenantId, type.id, "DRAFT"))!;
      // A draft is never pinned by a job (new jobs read PUBLISHED only), so its steps have no rows hanging off them.
      const gone = await tx.assemblyTemplateStep.deleteMany({ where: { versionId: version.id } });
      replaced = { version: version.version, steps: gone.count };
      version = await tx.assemblyTemplateVersion.update({ where: { id: version.id }, data: { preparedById: actor.userId, approvedById: null, notes } });
    } else {
      const max = await tx.assemblyTemplateVersion.aggregate({ _max: { version: true }, where: { templateId: template.id } });
      version = await tx.assemblyTemplateVersion.create({
        data: { templateId: template.id, version: (max._max.version ?? 0) + 1, status: "DRAFT", preparedById: actor.userId, notes },
      });
    }
    await tx.assemblyTemplateStep.createMany({
      data: report.steps.map((s) => ({
        versionId: version.id,
        seq: s.seq,
        groupCode: s.groupCode,
        groupName: s.groupName,
        srNo: s.srNo,
        activity: s.activity,
        kind: s.kind,
        defaultDepartmentId: s.defaultDepartmentId,
        qcpSrNo: s.qcpSrNo,
        jointRef: null,
        leadTimeProcessSeq: s.leadTimeProcessSeq,
        requiresQc: s.requiresQc,
        role: s.role,
        pressurePart: s.pressurePart,
        scope: s.scope,
        jointType: s.jointType,
      })),
    });
    await recordAudit(tx, actor, {
      action: "assemblyTemplate.import",
      entityType: "AssemblyTemplateVersion",
      entityId: version.id,
      before: replaced,
      after: {
        equipmentType: type.code,
        version: version.version,
        status: "DRAFT",
        label: report.label,
        steps: report.steps.length,
        perJoint: report.steps.filter((s) => s.scope === "PER_JOINT").length,
        collapses: report.collapses.length,
        fileSha256: report.fileSha256,
        preparedBy: actor.userId,
        provisional: "roles and pressure flags are inferred from the activity text",
      },
      eventType: "AssemblySequenceImported",
      eventPayload: { versionId: version.id, equipmentTypeId: type.id },
    });
    return { outcome: report.outcome, versionId: version.id, version: version.version, steps: report.steps.length };
  });
}

function latestVersion(tx: Tx, tenantId: number, equipmentTypeId: number, status: "DRAFT" | "PUBLISHED") {
  return tx.assemblyTemplateVersion.findFirst({
    where: { status, template: { tenantId, equipmentTypeId } },
    orderBy: { version: "desc" },
  });
}

export async function publishAssemblyTemplateVersion(
  actor: Actor,
  input: { versionId: number },
): Promise<{ versionId: number; version: number; publishedAt: Date }> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.PRODUCTION_HEAD);
  if (!Number.isInteger(input.versionId) || input.versionId <= 0) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Choose a version." });

  return withTenant(actor.tenantId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM assembly_template_versions WHERE id = ${input.versionId} FOR UPDATE`;
    const v = await tx.assemblyTemplateVersion.findFirst({
      where: { id: input.versionId, template: { tenantId: actor.tenantId } },
      include: { template: { include: { equipmentType: true } }, steps: true },
    });
    if (!v) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "AssemblyTemplateVersion", versionId: input.versionId });
    if (v.status !== "DRAFT") throw new AppError(ERROR_CODES.TEMPLATE_VERSION_LOCKED, { versionId: v.id, status: v.status });
    const type = v.template.equipmentType;
    if (!type) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Only an equipment type's own assembly sequence is published here." });
    if (v.preparedById != null && v.preparedById === actor.userId) {
      throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { reason: "The person who imported a sequence cannot publish it. Another Production Head must." });
    }
    if (v.steps.length === 0) throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, { reason: "This sequence has no steps." });
    if (v.steps.some(isSeamDriven)) {
      const questions = await tx.configQuestion.findMany({
        where: { tenantId: actor.tenantId, familyId: type.familyId, key: "shell_courses", active: true },
        select: { equipmentTypeId: true },
      });
      if (questionsForLine(questions as never, type.id).length === 0) {
        throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, {
          reason: "This sequence has welds that follow the shell courses, but the equipment type has no 'Shell courses' question to plan them from. Add the question first.",
        });
      }
    }
    const publishedAt = await dbNow(tx);
    await tx.assemblyTemplateVersion.update({ where: { id: v.id }, data: { status: "PUBLISHED", publishedAt, approvedById: actor.userId } });
    await recordAudit(tx, actor, {
      action: "assemblyTemplate.publish",
      entityType: "AssemblyTemplateVersion",
      entityId: v.id,
      before: { status: "DRAFT", preparedBy: v.preparedById },
      after: { status: "PUBLISHED", equipmentType: type.code, version: v.version, steps: v.steps.length, approvedBy: actor.userId },
      eventType: "AssemblyTemplatePublished",
      eventPayload: { versionId: v.id, equipmentTypeId: type.id },
    });
    return { versionId: v.id, version: v.version, publishedAt };
  });
}

// ── Read for the screen ──────────────────────────────────────────────────────

export interface AssemblyVersionView {
  id: number;
  version: number;
  status: string;
  publishedAt: Date | null;
  notes: string | null;
  preparedById: number | null;
  preparedByName: string | null;
  approvedByName: string | null;
  /** Jobs/lines already pinned to this version. */
  pinnedLines: number;
  steps: {
    seq: number;
    groupCode: string;
    srNo: string;
    activity: string;
    kind: string;
    department: string;
    leadTimeProcessSeq: number | null;
    scope: string;
    jointType: string | null;
    role: string | null;
    pressurePart: boolean;
  }[];
}

export async function loadAssemblyVersions(actor: Actor, equipmentTypeId: number): Promise<AssemblyVersionView[]> {
  guard(actor, ASSEMBLY_IMPORT_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    await loadType(tx, actor.tenantId, equipmentTypeId);
    const versions = await tx.assemblyTemplateVersion.findMany({
      where: { template: { tenantId: actor.tenantId, equipmentTypeId } },
      orderBy: { version: "desc" },
      include: {
        preparedBy: { select: { name: true } },
        approvedBy: { select: { name: true } },
        steps: { orderBy: { seq: "asc" }, include: { defaultDepartment: { select: { name: true } } } },
        _count: { select: { equipments: true } },
      },
    });
    return versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      publishedAt: v.publishedAt,
      notes: v.notes,
      preparedById: v.preparedById,
      preparedByName: v.preparedBy?.name ?? null,
      approvedByName: v.approvedBy?.name ?? null,
      pinnedLines: v._count.equipments,
      steps: v.steps.map((s) => ({
        seq: s.seq,
        groupCode: s.groupCode,
        srNo: s.srNo,
        activity: s.activity,
        kind: s.kind,
        department: s.defaultDepartment.name,
        leadTimeProcessSeq: s.leadTimeProcessSeq,
        scope: s.scope,
        jointType: s.jointType,
        role: s.role,
        pressurePart: s.pressurePart,
      })),
    }));
  });
}
