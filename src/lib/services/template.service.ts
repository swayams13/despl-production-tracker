import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { ROLES, requireRole, assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createTemplateSchema,
  cloneVersionSchema,
  saveDraftVersionSchema,
  publishVersionSchema,
  type CreateTemplateInput,
  type CloneVersionInput,
  type SaveDraftVersionInput,
  type PublishVersionInput,
  type TemplateWarningCode,
} from "@/lib/shared/schemas";
import { copyVersionContents } from "./template-copy";
import { analyzeGraph, computeEnvelope, DEFAULT_CALENDAR, type ScheduleProcess, type ScheduleEdge } from "@/lib/schedule";
import type { ProcessTemplateVersion, TemplateProcess, TemplateEdge } from "@/generated/prisma/client";

/**
 * Process route authoring (docs/superpowers/specs/2026-08-22-route-authoring-design.md).
 *
 * The discipline this file exists to enforce: a PUBLISHED
 * ProcessTemplateVersion is immutable (invariant #9). Every edit path either
 * targets a DRAFT or creates a new version — never both, never neither. Jobs
 * pin a version at creation and keep it forever, so mutating a published one
 * would silently rewrite the plan of every job already running against it.
 *
 * `updateStandardDurations` in admin.service.ts stays where it is: a narrower,
 * already-tested contract (edit durations → publish in one shot) that this
 * file's saveDraft → publish flow deliberately does not absorb.
 */

/** Start a route for a family that has none. The result is an empty v1 DRAFT. */
export async function createTemplate(
  actor: Actor,
  input: CreateTemplateInput,
): Promise<ProcessTemplateVersion> {
  const { familyId, name } = createTemplateSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const family = await tx.productFamily.findFirst({
      where: { id: familyId, tenantId: actor.tenantId },
    });
    if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId });

    return audited(tx, actor, async () => {
      const template = await tx.processTemplate.create({
        data: { tenantId: actor.tenantId, familyId, name },
      });
      const version = await tx.processTemplateVersion.create({
        data: { templateId: template.id, version: 1, status: "DRAFT" },
      });
      return {
        result: version,
        audit: {
          action: "template.create",
          entityType: "ProcessTemplateVersion",
          entityId: version.id,
          after: { templateId: template.id, familyId, name, version: 1, status: "DRAFT" },
          eventType: "ProcessTemplateCreated",
          eventPayload: { templateId: template.id, versionId: version.id, familyId },
        },
      };
    });
  });
}

/**
 * Deep-copy a version into a new DRAFT — the primary authoring path, because
 * nobody types 36 processes from a blank page.
 *
 * Durations are copied VERBATIM, including into another family. That is
 * deliberate: silently nulling them would hide the author's decision about
 * whether the source's numbers apply here. If they don't, the author must
 * change them or mark the process provisional, and the publish warning will
 * say so either way (invariant #10).
 */
export async function cloneVersion(
  actor: Actor,
  input: CloneVersionInput,
): Promise<ProcessTemplateVersion> {
  const { sourceVersionId, targetFamilyId, name, notes } = cloneVersionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const source = await tx.processTemplateVersion.findFirst({
      where: { id: sourceVersionId, template: { tenantId: actor.tenantId } },
      include: { template: true },
    });
    if (!source) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        entity: "ProcessTemplateVersion",
        sourceVersionId,
      });
    }

    let templateId = source.templateId;
    let version: number;
    if (targetFamilyId != null) {
      const family = await tx.productFamily.findFirst({
        where: { id: targetFamilyId, tenantId: actor.tenantId },
      });
      if (!family) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId: targetFamilyId });
      }
      const created = await tx.processTemplate.create({
        data: { tenantId: actor.tenantId, familyId: targetFamilyId, name: name! },
      });
      templateId = created.id;
      version = 1;
    } else {
      const max = await tx.processTemplateVersion.aggregate({
        _max: { version: true },
        where: { templateId: source.templateId },
      });
      version = (max._max.version ?? 0) + 1;
    }

    return audited(tx, actor, async () => {
      const draft = await tx.processTemplateVersion.create({
        data: { templateId, version, status: "DRAFT", notes },
      });
      const idMap = await copyVersionContents(tx, source.id, draft.id);
      return {
        result: draft,
        audit: {
          action: "template.cloneVersion",
          entityType: "ProcessTemplateVersion",
          entityId: draft.id,
          before: { sourceVersionId: source.id, sourceTemplateId: source.templateId },
          after: { templateId, version, status: "DRAFT", processCount: idMap.size, notes },
          eventType: "ProcessTemplateVersionCloned",
          eventPayload: { sourceVersionId: source.id, newVersionId: draft.id, templateId },
        },
      };
    });
  });
}

/**
 * Full replace of a DRAFT's processes and edges.
 *
 * Full replace, not a per-row diff: the editor is a spreadsheet-shaped screen
 * where an author reorders, renumbers and rewires in one pass, and a diff
 * protocol for that is more code and more ways to half-apply. The cost is
 * that two concurrent editors would clobber each other, which the
 * `expectedUpdatedAt` check below is what prevents.
 *
 * Validation here is deliberately thin — an author mid-edit is allowed to
 * hold a broken graph. Only structural impossibilities are refused now;
 * everything about whether the route makes SENSE waits for publishVersion.
 */
export async function saveDraftVersion(
  actor: Actor,
  input: SaveDraftVersionInput,
): Promise<ProcessTemplateVersion> {
  const { versionId, expectedUpdatedAt, processes, edges } = saveDraftVersionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  // Cheap, caller-shape-only checks before any DB round trip.
  const keys = new Set<string>();
  for (const p of processes) {
    if (keys.has(p.key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "duplicate process key", key: p.key });
    }
    keys.add(p.key);
  }
  const codes = new Set<string>();
  const seqs = new Set<number>();
  for (const p of processes) {
    if (codes.has(p.code)) {
      throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, { reason: "duplicate process code", code: p.code });
    }
    codes.add(p.code);
    if (seqs.has(p.seq)) {
      throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, { reason: "duplicate sequence number", seq: p.seq });
    }
    seqs.add(p.seq);
  }
  for (const e of edges) {
    if (!keys.has(e.processKey) || !keys.has(e.predecessorKey)) {
      throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
        reason: "edge references a process that is not in this route",
        processKey: e.processKey,
        predecessorKey: e.predecessorKey,
      });
    }
    if (e.processKey === e.predecessorKey) {
      throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
        reason: "a process cannot be its own predecessor",
        processKey: e.processKey,
      });
    }
  }

  return withTenant(actor.tenantId, async (tx) => {
    // Lock the row FOR UPDATE before the staleness read: same precedent as
    // _shared.ts's persistScheduleRun/lockProcessPlanForUpdate. Without this,
    // two concurrent saves starting from the same updatedAt both pass the
    // plain-read staleness check and the second's unconditional final update
    // silently clobbers the first author's whole pass. With the lock, a
    // second concurrent call blocks here until the first transaction
    // (including its final updatedAt bump) commits, so its own findFirst
    // read below sees the new stamp and correctly throws STALE_WRITE.
    await tx.$queryRaw`SELECT id FROM process_template_versions WHERE id = ${versionId} FOR UPDATE`;
    const version = await tx.processTemplateVersion.findFirst({
      where: { id: versionId, template: { tenantId: actor.tenantId } },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", versionId });
    }
    if (version.status !== "DRAFT") {
      // Invariant #9 enforced at the service layer — the UI hiding the Save
      // button is not enforcement.
      throw new AppError(ERROR_CODES.TEMPLATE_VERSION_LOCKED, { versionId, status: version.status });
    }
    const currentStamp = version.updatedAt?.getTime() ?? null;
    const expectedStamp = expectedUpdatedAt?.getTime() ?? null;
    if (currentStamp !== expectedStamp) {
      throw new AppError(ERROR_CODES.STALE_WRITE, { versionId });
    }

    const departmentIds = [...new Set(processes.map((p) => p.defaultDepartmentId))];
    if (departmentIds.length > 0) {
      const found = await tx.department.count({
        where: { id: { in: departmentIds }, tenantId: actor.tenantId },
      });
      if (found !== departmentIds.length) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Department", departmentIds });
      }
    }

    const before = {
      processCount: await tx.templateProcess.count({ where: { versionId } }),
      edgeCount: await tx.templateEdge.count({ where: { versionId } }),
    };

    return audited(tx, actor, async () => {
      // TemplateEdge cascades on both its process FKs, so deleting the
      // processes takes the edges with them; the explicit edge delete first
      // is belt-and-braces for a draft that somehow holds orphan edges.
      await tx.templateEdge.deleteMany({ where: { versionId } });
      await tx.templateProcess.deleteMany({ where: { versionId } });

      const idByKey = new Map<string, number>();
      for (const p of processes) {
        const row = await tx.templateProcess.create({
          data: {
            versionId,
            seq: p.seq,
            code: p.code,
            name: p.name,
            mainActivities: p.mainActivities,
            defaultDepartmentId: p.defaultDepartmentId,
            durationMinDays: p.durationMinDays,
            durationMaxDays: p.durationMaxDays,
            envelopeStartByMinDays: p.envelopeStartByMinDays,
            envelopeStartByMaxDays: p.envelopeStartByMaxDays,
            envelopeFinishByMinDays: p.envelopeFinishByMinDays,
            envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
            workOrderStages: p.workOrderStages,
            optional: p.optional,
            provisional: p.provisional,
          },
        });
        idByKey.set(p.key, row.id);
      }
      for (const e of edges) {
        await tx.templateEdge.create({
          data: {
            versionId,
            processId: idByKey.get(e.processKey)!,
            predecessorId: idByKey.get(e.predecessorKey)!,
            type: e.type,
            lagDays: e.lagDays,
          },
        });
      }

      const saved = await tx.processTemplateVersion.update({
        where: { id: versionId },
        data: { updatedAt: new Date() },
      });

      return {
        result: saved,
        audit: {
          action: "template.saveDraft",
          entityType: "ProcessTemplateVersion",
          entityId: versionId,
          before,
          after: { processCount: processes.length, edgeCount: edges.length },
          eventType: "ProcessTemplateDraftSaved",
          eventPayload: { versionId, processCount: processes.length, edgeCount: edges.length },
        },
      };
    });
  });
}

export interface TemplateWarning {
  code: TemplateWarningCode;
  message: string;
  /** TemplateProcess.code values this warning is about; empty when route-wide. */
  processCodes: string[];
}

export interface PublishResult {
  version: ProcessTemplateVersion;
  warnings: TemplateWarning[];
  /** Computed lead time in days, or null when the route is not schedulable. */
  envelopeDays: number | null;
}

/** TemplateProcess → the pure engine's shape. Mirrors _shared.ts's jobProcessToScheduleProcess. */
function templateProcessToScheduleProcess(p: TemplateProcess): ScheduleProcess {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    durationMinDays: p.durationMinDays,
    durationMaxDays: p.durationMaxDays,
    envelopeFinishByMinDays: p.envelopeFinishByMinDays,
    envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
    envelopeStartByMinDays: p.envelopeStartByMinDays,
    envelopeStartByMaxDays: p.envelopeStartByMaxDays,
    provisional: p.provisional,
  };
}

function templateEdgeToScheduleEdge(e: TemplateEdge): ScheduleEdge {
  return { processId: e.processId, predecessorId: e.predecessorId, type: e.type, lagDays: e.lagDays };
}

/**
 * Everything that decides whether a route may be published, split out so the
 * publish dialog can dry-run it without writing.
 *
 * Throws on a blocking failure; returns warnings otherwise. Each throw's
 * `detail.processCodes` names the offending processes so the UI can say
 * "Process 14 'PWHT' cannot be reached from the start of the route" rather
 * than "invalid graph" (invariant #12).
 */
export async function validateVersionForPublish(
  tx: Tx,
  versionId: number,
  expectedEnvelopeDays: number | null,
): Promise<{ warnings: TemplateWarning[]; envelopeDays: number | null }> {
  const processes = await tx.templateProcess.findMany({ where: { versionId }, orderBy: { seq: "asc" } });
  const edges = await tx.templateEdge.findMany({ where: { versionId } });

  if (processes.length === 0) {
    throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, {
      reason: "a route needs at least one process",
      processCodes: [],
    });
  }

  const codeById = new Map(processes.map((p) => [p.id, p.code]));
  const namesFor = (ids: number[]) => ids.map((i) => codeById.get(i)!).filter(Boolean);

  // Contiguous seq from 1. Duplicates are already refused at save time, so a
  // gap is the only way to get here.
  const seqs = processes.map((p) => p.seq).sort((a, b) => a - b);
  const gap = seqs.findIndex((s, i) => s !== i + 1);
  if (gap !== -1) {
    throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, {
      reason: "sequence numbers must run 1, 2, 3 … with no gaps",
      seq: seqs[gap],
      processCodes: [processes.find((p) => p.seq === seqs[gap])!.code],
    });
  }

  const diag = analyzeGraph(processes.map(templateProcessToScheduleProcess), edges.map(templateEdgeToScheduleEdge));

  if (diag.danglingEdges.length > 0 || diag.selfEdges.length > 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      reason: "an edge points at a process that is not part of this route, or at itself",
      processCodes: namesFor([
        ...diag.danglingEdges.map((e) => e.processId),
        ...diag.selfEdges.map((e) => e.processId),
      ]),
    });
  }
  if (diag.cycleNodeIds.length > 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      reason: "these processes form a loop, so none of them could ever start",
      processCodes: namesFor(diag.cycleNodeIds),
    });
  }
  if (diag.rootIds.length === 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      reason: "no process can start first — every process has a predecessor",
      processCodes: [],
    });
  }
  if (diag.unreachableIds.length > 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      reason: "these processes cannot be reached from the start of the route and would never begin",
      processCodes: namesFor(diag.unreachableIds),
    });
  }

  const warnings: TemplateWarning[] = [];

  const provisional = processes.filter(
    (p) => p.provisional || p.durationMinDays == null || p.durationMaxDays == null,
  );
  if (provisional.length > 0) {
    warnings.push({
      code: "PROVISIONAL_DURATIONS",
      message:
        `${provisional.length} process${provisional.length === 1 ? "" : "es"} have no confirmed duration. ` +
        "This route can be published and will drive gating and progress, but dates cannot be computed " +
        "for any job that uses it until the durations are confirmed.",
      processCodes: provisional.map((p) => p.code),
    });
  }

  if (diag.terminalIds.length > 1) {
    warnings.push({
      code: "MULTIPLE_TERMINALS",
      message:
        `${diag.terminalIds.length} processes end without feeding another. That is normal for branches ` +
        "that genuinely finish on their own — check none of them is a wiring mistake.",
      processCodes: namesFor(diag.terminalIds),
    });
  }

  const noStages = processes.filter((p) => p.workOrderStages.length === 0);
  if (noStages.length > 0) {
    warnings.push({
      code: "EMPTY_WORK_ORDER_STAGES",
      message:
        `${noStages.length} process${noStages.length === 1 ? "" : "es"} are not mapped to a work-order stage. ` +
        "That is correct for families with no 25-stage reporting view.",
      processCodes: noStages.map((p) => p.code),
    });
  }

  // Envelope check (invariant #10). computeEnvelope refuses a provisional or
  // duration-less spine outright, so this only runs when nothing is
  // provisional — the two warnings never both fire.
  let envelopeDays: number | null = null;
  if (provisional.length === 0) {
    const anchor = new Date("2000-01-03T00:00:00.000Z"); // a Monday; only the span matters
    const dates = computeEnvelope(
      processes.map(templateProcessToScheduleProcess),
      anchor,
      DEFAULT_CALENDAR,
    );
    const latest = Math.max(...dates.map((d) => d.plannedFinishMax.getTime()));
    envelopeDays = Math.round((latest - anchor.getTime()) / 86_400_000);

    if (expectedEnvelopeDays != null) {
      const drift = Math.abs(envelopeDays - expectedEnvelopeDays);
      // 7 days: the printed lead-time table is rounded to whole weeks
      // (BUILD-SPEC-v2 §1), so anything inside a week is rounding, not error.
      if (drift > 7) {
        warnings.push({
          code: "ENVELOPE_MISMATCH",
          message:
            `This route computes to ${envelopeDays} days, but the expected lead time is ` +
            `${expectedEnvelopeDays} days — a gap of ${drift} days. Check the lags between processes: ` +
            "summing durations instead of overlapping concurrent work is the usual cause.",
          processCodes: [],
        });
      }
    }
  }

  return { warnings, envelopeDays };
}

/**
 * Validate a DRAFT and publish it. After this the version is immutable and
 * jobs may pin it (invariant #9).
 *
 * `acknowledgedWarnings` is not security — it is a receipt that the author was
 * shown what publishing this route means, particularly that a provisional
 * route will refuse to produce dates.
 */
export async function publishVersion(
  actor: Actor,
  input: PublishVersionInput,
): Promise<PublishResult> {
  const { versionId, notes, acknowledgedWarnings, expectedEnvelopeDays } =
    publishVersionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const version = await tx.processTemplateVersion.findFirst({
      where: { id: versionId, template: { tenantId: actor.tenantId } },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", versionId });
    }
    if (version.status !== "DRAFT") {
      throw new AppError(ERROR_CODES.TEMPLATE_VERSION_LOCKED, { versionId, status: version.status });
    }

    const { warnings, envelopeDays } = await validateVersionForPublish(tx, versionId, expectedEnvelopeDays);

    const unacknowledged = warnings.filter((w) => !acknowledgedWarnings.includes(w.code));
    if (unacknowledged.length > 0) {
      throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, {
        reason: "confirm the warnings before publishing",
        unacknowledgedWarnings: unacknowledged.map((w) => w.code),
        processCodes: [],
      });
    }

    return audited(tx, actor, async () => {
      const published = await tx.processTemplateVersion.update({
        where: { id: versionId },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(), // server clock, invariant #1
          publishedBy: actor.userId,
          notes,
        },
      });
      return {
        result: { version: published, warnings, envelopeDays },
        audit: {
          action: "template.publish",
          entityType: "ProcessTemplateVersion",
          entityId: versionId,
          before: { status: version.status },
          after: {
            status: "PUBLISHED",
            notes,
            envelopeDays,
            warnings: warnings.map((w) => w.code),
          },
          eventType: "ProcessTemplateVersionPublished",
          eventPayload: { versionId, templateId: version.templateId, envelopeDays },
        },
      };
    });
  });
}
