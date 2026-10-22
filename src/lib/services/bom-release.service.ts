import aliases from "../../../seed/standard-parts-aliases.json";
import { withJob, withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertNotClientUser, requireRole, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { BOM_RELEASE_ROLES } from "@/lib/shared/stores-access";
import { bomReleaseTargetSchema, startBomRevisionSchema, mapBomLinesSchema, releaseBomRevisionSchema, type BomReleaseTargetInput, type StartBomRevisionInput, type MapBomLinesInput, type ReleaseBomRevisionInput } from "@/lib/shared/schemas";
import { JOINT_TYPE_LABEL } from "@/lib/shared/weld-map";
import { pickRouteTemplate } from "@/lib/shared/stage-mapping";
import type { JointType } from "@/generated/prisma/client";
import { flushRuleDecisions, LineRules } from "./config-rules";
import { approvedComponentTypeIds, materializeComponentsFromBomItems } from "./component.service";
import { materializeAssemblyStepsFromTemplate } from "./assembly.service";
import { ensureDraftRevisionTx } from "./bom.service";
import { applyReleaseDiff, diffIsEmpty, previewDiff, type ReleaseDiff } from "./bom-release-diff";
import { loadSkippedQcpItems } from "./assembly-qcp-match";
import { buildReleaseWarnings, suggestPartFamily, type PartFamilySuggestion, type ReleaseWarning } from "./bom-release.rules";
import { activeRow } from "./active-row";

/**
 * J5a: floor steps are generated at BOM release (J-PHASE-PLAN-v1 §B.J5a).
 *
 * createJob makes the job, lines, units, processes and schedule only. Releasing a line's BOM
 * revision makes, in one transaction, its components, component operations (approved part
 * families only, route variant picked, includeWhen applied), assembly steps (scoped steps x
 * planned joints x units, per-component over the components just made) and their QCP links.
 *
 *  - Idempotent by revision: `bom_revisions.materialized_at`. The same revision again is a no-op.
 *  - Another revision after one is materialised (J5c): a DIFF. Floor rows not started are updated or retired,
 *    started ones are flagged for review, nothing is deleted. The current revision again is a weld-map / answer
 *    resync by the same diff; an empty diff is a no-op. An older revision is refused (BOM_REVISION_NOT_INCREASING).
 *  - A line that already has components or steps from the old createJob path is refused
 *    (BOM_ALREADY_MATERIALIZED): existing jobs are never touched.
 *  - The preview IS the release run inside a transaction that is rolled back, so what it
 *    reports is what a release would do (ponytail: it consumes sequence ids, harmless).
 */

export type BomReleaseState = "READY" | "REFUSED" | "ALREADY_RELEASED" | "LEGACY_MATERIALIZED" | "DIFF" | "SUPERSEDED";

export interface BomReleaseLine {
  bomItemId: number;
  itemNo: number;
  partName: string;
  qtyPer: number | null;
  componentTypeId: number | null;
  partFamilyCode: string | null;
  partFamilyName: string | null;
  approved: boolean;
  /** The variant the line names (null = the lowest letter with a published version). */
  routeVariant: string | null;
  /** The variant a release would use. */
  effectiveVariant: string | null;
  variantsAvailable: string[];
  /** Operations the component would get after the line's rules. */
  operations: number;
  pressureRetaining: boolean;
  issue: null | { code: "ROUTE_NOT_APPROVED"; reason: "PART_FAMILY_NOT_APPROVED" | "VARIANT_NOT_PUBLISHED"; message: string };
  /** For a line with no part family: a guess, never applied. */
  suggestion: PartFamilySuggestion | null;
}

export interface BomReleaseCounts {
  components: number;
  operations: number;
  steps: number;
  stepsByScope: Record<string, number>;
  boundToQcp: number;
  unmappedLines: number;
  ruleDecisions: number;
}

export interface BomReleasePreview {
  equipment: { id: number; name: string; units: number };
  revision: { id: number; revisionNo: number; status: "DRAFT" | "RELEASED"; materializedAt: Date | null };
  state: BomReleaseState;
  lines: BomReleaseLine[];
  refusals: { code: "ROUTE_NOT_APPROVED"; bomItemId: number; itemNo: number; message: string }[];
  warnings: ReleaseWarning[];
  /** What a release would make (READY), or what the earlier release made (ALREADY_RELEASED). */
  counts: BomReleaseCounts | null;
  /** J5c: the changes a re-release (state DIFF) would make to the floor rows; the preview trims `rows`. */
  diff: ReleaseDiff | null;
  /** J5c: the line's current materialised revision number (null before the first release). */
  currentRevisionNo: number | null;
}

export interface BomReleaseResult {
  noop: boolean;
  counts: BomReleaseCounts;
  warnings: ReleaseWarning[];
  /** J5c: counts of what a re-release changed. */
  diff?: ReleaseDiff["counts"];
}

const aliasWords: Record<string, string> = Object.fromEntries(
  Object.entries(aliases.rawForms as Record<string, string | null>).flatMap(([label, code]) => (code ? [[label.toLowerCase().split(/[^a-z]+/)[0], code]] : [])),
);

function guard(actor: Actor) {
  assertNotClientUser(actor);
  requireRole(actor, ...BOM_RELEASE_ROLES);
}

async function jobIdOf(actor: Actor, equipmentId: number): Promise<number> {
  return withTenant(actor.tenantId, async (tx) => {
    const e = await tx.equipment.findFirst({ where: { id: equipmentId, job: { tenantId: actor.tenantId } }, select: { jobId: true } });
    if (!e) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Equipment", equipmentId });
    return e.jobId;
  });
}

async function storedCounts(tx: Tx, equipmentId: number, unmappedLines: number): Promise<BomReleaseCounts> {
  const [components, operations, steps, ruleDecisions] = await Promise.all([
    tx.component.count({ where: { ...activeRow, equipmentId } }),
    tx.componentOperation.count({ where: { ...activeRow, component: { equipmentId } } }),
    tx.assemblyStep.groupBy({ by: ["templateStepId"], where: { ...activeRow, unit: { equipmentId } }, _count: true }),
    tx.configRuleDecision.count({ where: { equipmentId } }),
  ]);
  const scopes = steps.length
    ? await tx.assemblyTemplateStep.findMany({ where: { id: { in: steps.map((s) => s.templateStepId) } }, select: { id: true, scope: true } })
    : [];
  const scopeOf = new Map(scopes.map((s) => [s.id, s.scope]));
  const stepsByScope: Record<string, number> = {};
  let total = 0;
  for (const s of steps) {
    total += s._count;
    const sc = scopeOf.get(s.templateStepId) ?? "PER_UNIT";
    stepsByScope[sc] = (stepsByScope[sc] ?? 0) + s._count;
  }
  return { components, operations, steps: total, stepsByScope, boundToQcp: 0, unmappedLines, ruleDecisions };
}

/** Everything the preview and the release share. Writes the floor rows only when state is READY. J7a: also run by previewJob inside its own rolled-back transaction. */
export async function runBomRelease(tx: Tx, actor: Actor, equipmentId: number, bomRevisionId: number): Promise<BomReleasePreview> {
  const equipment = await tx.equipment.findFirst({
    where: { id: equipmentId, job: { tenantId: actor.tenantId } },
    select: {
      id: true,
      name: true,
      jobId: true,
      equipmentTypeId: true,
      config: true,
      assemblyTemplateVersionId: true,
      job: { select: { familyId: true } },
      templateVersion: { select: { template: { select: { familyId: true } } } },
      units: { select: { id: true, serialNo: true }, orderBy: { id: "asc" } },
    },
  });
  if (!equipment) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Equipment", equipmentId });
  // Two releases on one line serialise here: the loser then sees the winner's materialized_at.
  await tx.$queryRaw`SELECT id FROM equipments WHERE id = ${equipmentId} FOR UPDATE`;
  const revision = await tx.bomRevision.findFirst({ where: { id: bomRevisionId, equipmentId }, select: { id: true, revisionNo: true, status: true, materializedAt: true } });
  if (!revision) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomRevision", bomRevisionId });

  const base = {
    equipment: { id: equipment.id, name: equipment.name, units: equipment.units.length },
    revision,
    lines: [] as BomReleaseLine[],
    refusals: [] as BomReleasePreview["refusals"],
    warnings: [] as ReleaseWarning[],
    diff: null as ReleaseDiff | null,
    currentRevisionNo: null as number | null,
  };

  // J5c: the line's current materialised revision decides what kind of release this is.
  const current = await tx.bomRevision.findFirst({ where: { equipmentId, materializedAt: { not: null } }, orderBy: { revisionNo: "desc" }, select: { id: true, revisionNo: true } });
  base.currentRevisionNo = current?.revisionNo ?? null;

  // Whatever the state, the lines are listed (read only unless READY or DIFF); only those two write floor rows.
  let early: Exclude<BomReleaseState, "READY" | "REFUSED" | "DIFF" | "ALREADY_RELEASED"> | null = null;
  if (current) {
    if (revision.revisionNo < current.revisionNo) early = "SUPERSEDED";
  } else {
    const [haveComponents, haveSteps] = await Promise.all([
      // j5c: any row, retired or not, means this line has floor rows
      tx.component.count({ where: { equipmentId } }),
      // j5c: any row, retired or not
      tx.assemblyStep.count({ where: { unit: { equipmentId } } }),
    ]);
    if (haveComponents + haveSteps > 0) early = "LEGACY_MATERIALIZED";
  }

  // ── Lines ────────────────────────────────────────────────────────────
  const familyId = equipment.templateVersion?.template.familyId ?? equipment.job.familyId;
  const rules = await LineRules.load(tx, equipmentId);
  const items = await tx.bomItem.findMany({
    where: { equipmentId, bomRevisionId },
    orderBy: { itemNo: "asc" },
    select: { id: true, itemNo: true, partName: true, qtyPer: true, componentTypeId: true, routeVariant: true },
  });
  const typeIds = [...new Set(items.flatMap((b) => (b.componentTypeId != null ? [b.componentTypeId] : [])))];
  const approvedIds = await approvedComponentTypeIds(tx, typeIds);
  const types = typeIds.length
    ? await tx.componentTypeRef.findMany({
        where: { id: { in: typeIds }, tenantId: actor.tenantId },
        select: { id: true, code: true, name: true, partFamily: { select: { pressureRetaining: true, status: true } } },
      })
    : [];
  const typeById = new Map(types.map((t) => [t.id, t]));
  const templates = typeIds.length
    ? await tx.routeTemplate.findMany({
        where: { tenantId: actor.tenantId, componentTypeId: { in: typeIds }, OR: [{ familyId }, { familyId: null }] },
        include: { versions: { where: { status: "PUBLISHED" }, orderBy: { version: "desc" }, take: 1, include: { steps: { orderBy: { seq: "asc" } } } } },
      })
    : [];
  const unmapped = items.filter((b) => b.componentTypeId == null);
  const options: PartFamilySuggestion[] = [];
  if (unmapped.length > 0) {
    const usable = await tx.componentTypeRef.findMany({
      where: { tenantId: actor.tenantId, active: true, OR: [{ kind: "RAW_FORM" }, { partFamily: { status: "APPROVED" } }] },
      select: { id: true, code: true, name: true },
    });
    options.push(...usable.map((u) => ({ componentTypeId: u.id, code: u.code, name: u.name, reason: "" })));
  }

  const lines: BomReleaseLine[] = items.map((b) => {
    const t = b.componentTypeId != null ? typeById.get(b.componentTypeId) : undefined;
    const candidates = templates.filter((x) => x.componentTypeId === b.componentTypeId);
    const route = pickRouteTemplate(b.routeVariant ? candidates.filter((x) => x.variant === b.routeVariant) : candidates);
    const version = route?.versions[0] ?? null;
    const approved = b.componentTypeId != null && approvedIds.has(b.componentTypeId);
    let issue: BomReleaseLine["issue"] = null;
    if (b.componentTypeId != null && !approved) {
      issue = { code: "ROUTE_NOT_APPROVED", reason: "PART_FAMILY_NOT_APPROVED", message: `Item ${b.itemNo} (${b.partName}): part family ${t?.code ?? ""} is not approved yet.` };
    } else if (b.componentTypeId != null && b.routeVariant && !version) {
      issue = { code: "ROUTE_NOT_APPROVED", reason: "VARIANT_NOT_PUBLISHED", message: `Item ${b.itemNo} (${b.partName}): route variant ${b.routeVariant} of ${t?.code ?? "this part family"} has no published version.` };
    }
    return {
      bomItemId: b.id,
      itemNo: b.itemNo,
      partName: b.partName,
      qtyPer: b.qtyPer != null ? Number(b.qtyPer) : null,
      componentTypeId: b.componentTypeId,
      partFamilyCode: t?.code ?? null,
      partFamilyName: t?.name ?? null,
      approved,
      routeVariant: b.routeVariant,
      effectiveVariant: version ? route!.variant : null,
      variantsAvailable: [...new Set(candidates.filter((x) => x.versions.length > 0).map((x) => x.variant))].sort(),
      operations: version ? version.steps.filter((st) => rules.peek(st.includeWhen).included).length : 0,
      pressureRetaining: !!t?.partFamily?.pressureRetaining && approved,
      issue,
      suggestion: b.componentTypeId == null ? suggestPartFamily(b.partName, options, aliasWords) : null,
    };
  });
  const refusals = lines.flatMap((l) => (l.issue ? [{ code: l.issue.code, bomItemId: l.bomItemId, itemNo: l.itemNo, message: l.issue.message }] : []));
  const unmappedLines = lines.filter((l) => l.componentTypeId == null).length;
  if (early) return { ...base, lines, state: early, counts: early === "SUPERSEDED" ? await storedCounts(tx, equipmentId, unmappedLines) : null };
  if (refusals.length > 0) return { ...base, lines, refusals, state: "REFUSED", counts: null };

  // ── Write the floor rows ─────────────────────────────────────────────
  const mapped = items.filter((b) => b.componentTypeId != null).map((b) => b.id);
  const qcp = await tx.qcpTemplate.findFirst({ where: { jobId: equipment.jobId }, select: { id: true } });
  const skippedQcp = qcp ? await loadSkippedQcpItems(tx, equipment.jobId) : [];
  let pressureCount: number;
  let boundToQcp: number;
  let emptyScopes: string[];
  let diff: ReleaseDiff | null = null;
  if (current) {
    // J5c: a re-release reconciles the floor rows with this revision instead of generating them.
    const res = await applyReleaseDiff(tx, actor, {
      equipment: { ...equipment, familyId },
      tenantId: actor.tenantId,
      targetRevisionId: revision.id,
      targetRevisionNo: revision.revisionNo,
      qcpTemplateId: qcp?.id ?? null,
      skippedQcp,
      rules,
    });
    if (diffIsEmpty(res.diff) && revision.id === current.id) {
      return { ...base, lines, state: "ALREADY_RELEASED", currentRevisionNo: current.revisionNo, counts: await storedCounts(tx, equipmentId, unmappedLines) };
    }
    diff = res.diff;
    pressureCount = res.pressureCount;
    boundToQcp = res.boundToQcp;
    emptyScopes = res.emptyScopes;
  } else {
    const comps = await materializeComponentsFromBomItems(tx, familyId, equipmentId, mapped, equipment.jobId, { release: true });
    const asm = await materializeAssemblyStepsFromTemplate(
      tx,
      actor.tenantId,
      equipment.jobId,
      familyId,
      equipment.units.map((u) => u.id),
      qcp?.id ?? null,
      equipment.equipmentTypeId,
      rules,
      skippedQcp,
      equipmentId,
      (equipment.config as Record<string, unknown> | null) ?? {},
    );
    pressureCount = comps.pressureCount;
    boundToQcp = asm.boundToQcp;
    emptyScopes = asm.emptyScopes;
  }
  await flushRuleDecisions(tx, [rules]);

  // ── Warnings ─────────────────────────────────────────────────────────
  const mappedTypeIds = new Set(typeIds);
  const kit = equipment.equipmentTypeId != null
    ? await tx.equipmentTypeComponent.findMany({ where: { equipmentTypeId: equipment.equipmentTypeId, tenantId: actor.tenantId }, select: { componentType: { select: { id: true, code: true } } } })
    : [];
  const noRoute = lines.filter((l) => l.componentTypeId != null && l.effectiveVariant == null);
  const warnings = buildReleaseWarnings({
    unmappedItemNos: lines.filter((l) => l.componentTypeId == null).map((l) => l.itemNo),
    noRouteItemNos: noRoute.map((l) => l.itemNo),
    unmappedKitCodes: kit.filter((k) => !mappedTypeIds.has(k.componentType.id)).map((k) => k.componentType.code),
    hasQcp: qcp != null,
    unconfirmedJoints: await tx.plannedJoint.count({ where: { equipmentId, confirmed: false, source: { not: "GENERATED" } } }),
    emptyJointTypes: emptyScopes.filter((s) => s.startsWith("joint:")).map((s) => JOINT_TYPE_LABEL[s.slice(6) as JointType].toLowerCase()),
    pressureParts: pressureCount,
  });

  const stored = await storedCounts(tx, equipmentId, unmappedLines);
  return {
    ...base,
    lines,
    warnings,
    diff,
    state: diff ? "DIFF" : "READY",
    counts: { ...stored, boundToQcp },
  };
}

class DryRun extends Error {
  constructor(readonly preview: BomReleasePreview) {
    super("dry run");
  }
}

/** Read only: what releasing this revision would do, as a rolled-back run of the release itself. */
export async function previewBomRelease(actor: Actor, input: BomReleaseTargetInput): Promise<BomReleasePreview> {
  const { equipmentId, bomRevisionId } = bomReleaseTargetSchema.parse(input);
  guard(actor);
  const jobId = await jobIdOf(actor, equipmentId);
  try {
    await withJob(actor.tenantId, jobId, async (tx) => {
      throw new DryRun(await runBomRelease(tx, actor, equipmentId, bomRevisionId));
    });
  } catch (e) {
    if (e instanceof DryRun) return e.preview.diff ? { ...e.preview, diff: previewDiff(e.preview.diff) } : e.preview;
    throw e;
  }
  throw new Error("unreachable");
}

/**
 * J5b "Start revision N": the line's draft BOM revision, started if it has none, with the line's
 * revision-less BOM items moved into it (audited). Safe to repeat: with a draft already there it
 * only moves any loose lines. A line that already has floor rows, or a materialised revision,
 * is refused like the release itself (existing jobs are never touched).
 */
export async function startBomRevision(actor: Actor, input: StartBomRevisionInput): Promise<{ bomRevisionId: number; revisionNo: number; created: boolean; moved: number; copied: number }> {
  const { equipmentId } = startBomRevisionSchema.parse(input);
  guard(actor);
  const jobId = await jobIdOf(actor, equipmentId);
  return withJob(actor.tenantId, jobId, async (tx) => {
    const r = await ensureDraftRevisionTx(tx, actor, equipmentId, jobId);
    // Only a line that predates the BOM release (floor rows, no materialised revision) is refused.
    if (!r) throw new AppError(ERROR_CODES.BOM_ALREADY_MATERIALIZED, { equipmentId });
    return { bomRevisionId: r.id, revisionNo: r.revisionNo, created: r.created, moved: r.moved, copied: r.copied };
  });
}

/**
 * Map BOM lines of a DRAFT revision to a part family and a route variant (null clears it). A line
 * may name a family that is not approved yet: the release refuses it then, the mapping is still a
 * record of what Engineering intends.
 */
export async function mapBomLines(actor: Actor, input: MapBomLinesInput): Promise<{ updated: number; unchanged: number }> {
  const { bomRevisionId, lines } = mapBomLinesSchema.parse(input);
  guard(actor);
  const found = await withTenant(actor.tenantId, (tx) =>
    tx.bomRevision.findFirst({ where: { id: bomRevisionId, equipment: { job: { tenantId: actor.tenantId } } }, select: { jobId: true } }),
  );
  if (!found) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomRevision", bomRevisionId });

  return withJob(actor.tenantId, found.jobId, async (tx) => {
    const revision = await tx.bomRevision.findFirst({ where: { id: bomRevisionId, jobId: found.jobId }, select: { id: true, equipmentId: true, status: true, materializedAt: true, revisionNo: true } });
    if (!revision) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomRevision", bomRevisionId });
    // Serialise with a release of the same line, then judge the revision.
    await tx.$queryRaw`SELECT id FROM equipments WHERE id = ${revision.equipmentId} FOR UPDATE`;
    const fresh = await tx.bomRevision.findUniqueOrThrow({ where: { id: bomRevisionId }, select: { status: true, materializedAt: true } });
    if (fresh.materializedAt) throw new AppError(ERROR_CODES.BOM_ALREADY_MATERIALIZED, { bomRevisionId });
    if (fresh.status !== "DRAFT") {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { bomRevisionId, status: fresh.status }, "Only a draft BOM revision can be mapped. Start a new revision instead.");
    }
    const items = await tx.bomItem.findMany({ where: { bomRevisionId, id: { in: lines.map((l) => l.bomItemId) } }, select: { id: true, componentTypeId: true, routeVariant: true } });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const missing = lines.filter((l) => !itemById.has(l.bomItemId)).map((l) => l.bomItemId);
    if (missing.length > 0) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomItem", bomItemIds: missing });
    const typeIds = [...new Set(lines.flatMap((l) => (l.componentTypeId != null ? [l.componentTypeId] : [])))];
    const okTypes = typeIds.length ? await tx.componentTypeRef.findMany({ where: { id: { in: typeIds }, tenantId: actor.tenantId }, select: { id: true } }) : [];
    if (okTypes.length !== typeIds.length) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ComponentTypeRef", componentTypeIds: typeIds });
    const badVariant = lines.filter((l) => l.componentTypeId == null && l.routeVariant != null).map((l) => l.bomItemId);
    if (badVariant.length > 0) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { bomItemIds: badVariant }, "A route variant needs a part family. Choose the part family first.");

    const changes = lines.filter((l) => {
      const cur = itemById.get(l.bomItemId)!;
      return cur.componentTypeId !== l.componentTypeId || cur.routeVariant !== l.routeVariant;
    });
    if (changes.length === 0) return { updated: 0, unchanged: lines.length };
    return audited(tx, actor, async () => {
      for (const c of changes) {
        await tx.bomItem.update({ where: { id: c.bomItemId }, data: { componentTypeId: c.componentTypeId, routeVariant: c.routeVariant } });
      }
      return {
        result: { updated: changes.length, unchanged: lines.length - changes.length },
        audit: {
          action: "bom.mapLines",
          entityType: "BomRevision",
          entityId: bomRevisionId,
          before: changes.map((c) => ({ bomItemId: c.bomItemId, componentTypeId: itemById.get(c.bomItemId)!.componentTypeId, routeVariant: itemById.get(c.bomItemId)!.routeVariant })),
          after: changes.map((c) => ({ bomItemId: c.bomItemId, componentTypeId: c.componentTypeId, routeVariant: c.routeVariant })),
          eventType: "BomLinesMapped",
          eventPayload: { bomRevisionId, changed: changes.length },
        },
      };
    });
  });
}

/**
 * Release a BOM revision: flips it to RELEASED and generates the line's floor rows, in one
 * transaction. Warnings must be acknowledged; refusals never can be.
 */
export async function releaseBomRevision(actor: Actor, input: ReleaseBomRevisionInput): Promise<BomReleaseResult> {
  const { equipmentId, bomRevisionId, acknowledgeWarnings } = releaseBomRevisionSchema.parse(input);
  guard(actor);
  const jobId = await jobIdOf(actor, equipmentId);

  return withJob(actor.tenantId, jobId, async (tx) => {
    const out = await runBomRelease(tx, actor, equipmentId, bomRevisionId);
    const target = { equipmentId, bomRevisionId };
    switch (out.state) {
      case "ALREADY_RELEASED":
        return audited(tx, actor, async () => ({
          result: { noop: true, counts: out.counts!, warnings: [] } satisfies BomReleaseResult,
          audit: { action: "bom.release.noop", entityType: "BomRevision", entityId: bomRevisionId, after: { ...target, counts: out.counts } },
        }));
      case "SUPERSEDED":
        throw new AppError(ERROR_CODES.BOM_REVISION_NOT_INCREASING, { ...target, revisionNo: out.revision.revisionNo, currentHighestRevisionNo: out.currentRevisionNo });
      case "LEGACY_MATERIALIZED":
        throw new AppError(ERROR_CODES.BOM_ALREADY_MATERIALIZED, target);
      case "REFUSED":
        throw new AppError(ERROR_CODES.ROUTE_NOT_APPROVED, { ...target, lines: out.refusals }, out.refusals[0].message);
      case "READY":
      case "DIFF":
        break;
    }
    // Throwing here rolls the floor rows run() just wrote back.
    if (out.warnings.length > 0 && !acknowledgeWarnings) {
      throw new AppError(ERROR_CODES.BOM_RELEASE_WARNINGS_UNACKNOWLEDGED, { ...target, warnings: out.warnings });
    }
    const counts = out.counts!;
    return audited(tx, actor, async () => {
      // Invariant 1: the clock is the database's. A revision released some other way keeps its released_at.
      // J5c: a resync of the current revision (weld map, answers) keeps its stamp.
      if (out.revision.materializedAt == null) {
        await tx.bomRevision.updateMany({ where: { equipmentId, status: "RELEASED", id: { not: bomRevisionId } }, data: { status: "DRAFT" } });
        await tx.$executeRaw`UPDATE bom_revisions SET status = 'RELEASED', released_at = COALESCE(released_at, now()), materialized_at = now() WHERE id = ${bomRevisionId}`;
      }
      return {
        result: { noop: false, counts, warnings: out.warnings, ...(out.diff ? { diff: out.diff.counts } : {}) } satisfies BomReleaseResult,
        audit: {
          action: "bom.release",
          entityType: "BomRevision",
          entityId: bomRevisionId,
          before: { status: out.revision.status, materializedAt: null },
          after: {
            status: "RELEASED",
            equipmentId,
            revisionNo: out.revision.revisionNo,
            components: counts.components,
            operations: counts.operations,
            steps: counts.steps,
            stepsByScope: counts.stepsByScope,
            boundToQcp: counts.boundToQcp,
            unmappedLines: counts.unmappedLines,
            ruleDecisions: counts.ruleDecisions,
            warningsAcknowledged: out.warnings.map((w) => w.code),
            // J5c: every changed row with its before/after fields (the preview showed the first 200).
            ...(out.diff ? { diff: out.diff, resync: out.revision.materializedAt != null, previousRevisionNo: out.currentRevisionNo } : {}),
          },
          eventType: "BomReleased",
          eventPayload: { equipmentId, bomRevisionId },
        },
      };
    });
  });
}
