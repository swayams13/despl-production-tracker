import type { Tx } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { FEATURES } from "@/lib/shared/flags";
import type { AssemblyStepRole, OperationStatus } from "@/generated/prisma/client";
import type { LineRules } from "./config-rules";
import { activeRow } from "./active-row";
import {
  buildComponentRows,
  componentKey,
  writeComponentRows,
  type ComponentOpRow,
  type ComponentRow,
} from "./component.service";
import { buildAssemblyStepRows, type AssemblyStepRow } from "./assembly.service";
import { lockFloorUnits, rollupForAssemblyStep, rollupForComponentOperation } from "./_shared";

/**
 * J5c: re-releasing a BOM revision (or checking a weld-map / answer change on the current one) reconciles the
 * line's floor rows with what a fresh release would make, without ever deleting a row (invariant 6):
 *  - not started and still wanted but different: updated in place;
 *  - not started and no longer wanted: retired (retired_at + reason);
 *  - started (anything past NOT_STARTED; for a part also an issue or a heat pick) and different or gone: kept and
 *    flagged `needs_review` until Engineering or the Production Head resolves it (bom-review.service);
 *  - wanted and missing: added.
 * Template and route versions stay as the line was pinned (invariant 9). The caller holds the equipment row lock.
 */

export type DiffClass = "add" | "update" | "retire" | "review";
export type DiffEntity = "component" | "operation" | "step";
export interface DiffField {
  field: string;
  from: unknown;
  to: unknown;
}
export interface DiffRow {
  entity: DiffEntity;
  id: number | null;
  unit: string | null;
  label: string;
  class: DiffClass;
  fields: DiffField[];
  status: string | null;
}
export interface ReleaseDiff {
  counts: Record<DiffEntity, Record<DiffClass, number>>;
  /** Every row; the preview trims it to PREVIEW_ROWS, the audit row keeps all of them. */
  rows: DiffRow[];
}
export const PREVIEW_ROWS = 200;

export function emptyDiff(): ReleaseDiff {
  const zero = () => ({ add: 0, update: 0, retire: 0, review: 0 });
  return { counts: { component: zero(), operation: zero(), step: zero() }, rows: [] };
}
export const diffIsEmpty = (d: ReleaseDiff) => d.rows.length === 0;
/** Display copy of a diff: the ids in `fields` become names ("Flange → Pipe"). The audit row keeps the raw diff. */
export async function namedDiff(tx: Tx, d: ReleaseDiff): Promise<ReleaseDiff> {
  const ids = { partFamily: new Set<number>(), operation: new Set<number>(), part: new Set<number>(), qcpItem: new Set<number>() };
  for (const r of d.rows) {
    for (const f of r.fields) {
      const set = ids[f.field as keyof typeof ids];
      if (set) for (const v of [f.from, f.to]) if (typeof v === "number") set.add(v);
    }
  }
  const list = (k: keyof typeof ids) => ({ in: [...ids[k]] });
  const [types, operations, parts, qcp] = await Promise.all([
    ids.partFamily.size ? tx.componentTypeRef.findMany({ where: { id: list("partFamily") }, select: { id: true, name: true } }) : [],
    ids.operation.size ? tx.operationRef.findMany({ where: { id: list("operation") }, select: { id: true, name: true } }) : [],
    // j5c: history (a part named in a diff may already be retired)
    ids.part.size ? tx.component.findMany({ where: { id: list("part") }, select: { id: true, tag: true } }) : [],
    ids.qcpItem.size ? tx.qcpItem.findMany({ where: { id: list("qcpItem") }, select: { id: true, srNo: true } }) : [],
  ]);
  const names: Record<string, Map<number, string>> = {
    partFamily: new Map(types.map((t) => [t.id, t.name])),
    operation: new Map(operations.map((o) => [o.id, o.name])),
    part: new Map(parts.map((c) => [c.id, c.tag])),
    qcpItem: new Map(qcp.map((q) => [q.id, q.srNo])),
  };
  const name = (field: string, v: unknown) => (typeof v === "number" && names[field]?.get(v)) || v;
  return { counts: d.counts, rows: d.rows.map((r) => ({ ...r, fields: r.fields.map((f) => ({ ...f, from: name(f.field, f.from), to: name(f.field, f.to) })) })) };
}
export function previewDiff(d: ReleaseDiff): ReleaseDiff {
  return { counts: d.counts, rows: d.rows.slice(0, PREVIEW_ROWS) };
}

const intQty = (q: unknown): number | null => (q != null && Number.isInteger(Number(q)) && Number(q) > 0 ? Number(q) : null);
const NOT_STARTED: OperationStatus = "NOT_STARTED";

interface LineFields {
  componentTypeId: number | null;
  routeVariant: string | null;
  partName: string;
  qtyPer: unknown;
}
/** The four fields whose change makes a part "changed" (plan §2): family, variant, name (the tag), integer quantity. */
function changedLineFields(old: LineFields, now: LineFields): DiffField[] {
  const out: DiffField[] = [];
  if (old.componentTypeId !== now.componentTypeId) out.push({ field: "partFamily", from: old.componentTypeId, to: now.componentTypeId });
  if ((old.routeVariant ?? null) !== (now.routeVariant ?? null)) out.push({ field: "routeVariant", from: old.routeVariant, to: now.routeVariant });
  if (old.partName !== now.partName) out.push({ field: "partName", from: old.partName, to: now.partName });
  if (intQty(old.qtyPer) !== intQty(now.qtyPer)) out.push({ field: "quantity", from: intQty(old.qtyPer), to: intQty(now.qtyPer) });
  return out;
}

/** Reason prefix `bom-review.service` writes when a row is cancelled. */
export const CANCELLED_IN_REVIEW = "cancelled in review";

/**
 * A row cancelled in review stays cancelled: the next check does not add it back until its BOM line changes again.
 * "Changes again" compares the line as it was in the revision in force when the row was cancelled with the line now
 * (the four fields of `changedLineFields`); revisions keep their lines, so nothing extra is stored.
 */
export class CancelledMemory {
  private history?: { revisions: { id: number; materializedAt: Date }[]; lines: Map<number, Map<number, LineFields>> };
  constructor(
    private readonly tx: Tx,
    private readonly equipmentId: number,
    /** The target revision's lines by item number. */
    private readonly current: Map<number, LineFields>,
  ) {}

  private async load() {
    if (this.history) return this.history;
    const revisions = (await this.tx.bomRevision.findMany({ where: { equipmentId: this.equipmentId, materializedAt: { not: null } }, select: { id: true, materializedAt: true }, orderBy: { materializedAt: "desc" } })).map((r) => ({ id: r.id, materializedAt: r.materializedAt! }));
    const items = await this.tx.bomItem.findMany({
      where: { equipmentId: this.equipmentId, bomRevisionId: { in: revisions.map((r) => r.id) } },
      select: { bomRevisionId: true, itemNo: true, partName: true, qtyPer: true, componentTypeId: true, routeVariant: true },
    });
    const lines = new Map<number, Map<number, LineFields>>();
    for (const it of items) {
      const m = lines.get(it.bomRevisionId!) ?? new Map<number, LineFields>();
      m.set(it.itemNo, it);
      lines.set(it.bomRevisionId!, m);
    }
    return (this.history = { revisions, lines });
  }

  /** True when BOM line `itemNo` reads the same now as in the revision that was released when the row was cancelled. */
  async lineUnchangedSince(itemNo: number, cancelledAt: Date): Promise<boolean> {
    const h = await this.load();
    const inForce = h.revisions.find((r) => r.materializedAt <= cancelledAt);
    const was = inForce ? h.lines.get(inForce.id)?.get(itemNo) : undefined;
    const now = this.current.get(itemNo);
    return was != null && now != null && changedLineFields(was, now).length === 0;
  }
}

export interface DiffContext {
  equipment: {
    id: number;
    jobId: number;
    familyId: number;
    equipmentTypeId: number | null;
    config: unknown;
    assemblyTemplateVersionId: number | null;
    units: { id: number; serialNo: string }[];
  };
  tenantId: number;
  targetRevisionId: number;
  targetRevisionNo: number;
  qcpTemplateId: number | null;
  skippedQcp: { srNo: string; sequence: number }[];
  rules: LineRules;
}
export interface DiffResult {
  diff: ReleaseDiff;
  pressureCount: number;
  boundToQcp: number;
  emptyScopes: string[];
  components: number;
  operations: number;
  steps: number;
  stepsByScope: Record<string, number>;
}

/** Rows whose plans need rolling up afterwards: `${kind}:${id}`. */
type Touch = { kind: "STEP" | "OP"; id: number };

class Recorder {
  readonly diff = emptyDiff();
  readonly touched: Touch[] = [];
  constructor(private readonly serialOf: Map<number | null, string>) {}
  add(
    entity: DiffEntity,
    cls: DiffClass,
    row: { id: number | null; unitId: number | null; label: string; fields?: DiffField[]; status?: string | null },
    touch?: Touch,
  ) {
    this.diff.counts[entity][cls]++;
    this.diff.rows.push({
      entity,
      id: row.id,
      unit: row.unitId == null ? null : (this.serialOf.get(row.unitId) ?? null),
      label: row.label,
      class: cls,
      fields: row.fields ?? [],
      status: row.status ?? null,
    });
    if (touch) this.touched.push(touch);
  }
}

export async function applyReleaseDiff(tx: Tx, actor: Actor, ctx: DiffContext): Promise<DiffResult> {
  const { equipment } = ctx;
  const unitIds = equipment.units.map((u) => u.id);
  await lockFloorUnits(tx, equipment.jobId, unitIds);
  const rec = new Recorder(new Map(equipment.units.map((u) => [u.id, u.serialNo])));
  const reason = `removed in BOM rev ${ctx.targetRevisionNo}`;
  const now = new Date();
  const retireData = { retiredAt: now, retiredReason: reason, needsReview: false };

  // ── What the target revision wants ────────────────────────────────────
  const targetItems = await tx.bomItem.findMany({
    where: { equipmentId: equipment.id, bomRevisionId: ctx.targetRevisionId },
    select: { id: true, itemNo: true, partName: true, qtyPer: true, componentTypeId: true, routeVariant: true },
  });
  const targetByNo = new Map(targetItems.map((b) => [b.itemNo, b]));

  // ── What exists ───────────────────────────────────────────────────────
  const existing = await tx.component.findMany({
    where: { ...activeRow, equipmentId: equipment.id },
    orderBy: { id: "asc" },
    select: {
      id: true,
      unitId: true,
      tag: true,
      componentTypeId: true,
      routeVersionId: true,
      pressureRetaining: true,
      bomItemId: true,
      bomItem: { select: { id: true, itemNo: true, partName: true, qtyPer: true, componentTypeId: true, routeVariant: true } },
      operations: {
        where: activeRow,
        orderBy: { seq: "asc" },
        select: { id: true, seq: true, operationId: true, status: true, requiresQc: true, qtyPlanned: true, needsReview: true },
      },
    },
  });
  const lined = existing.filter((c) => c.bomItem != null); // a part with no BOM line is not this release's to touch
  const ids = lined.map((c) => c.id);
  const [issued, picked] = ids.length
    ? await Promise.all([
        tx.stockTxn.findMany({ where: { componentId: { in: ids }, type: "ISSUE" }, select: { componentId: true }, distinct: ["componentId"] }),
        tx.materialIdentification.findMany({ where: { componentId: { in: ids } }, select: { componentId: true }, distinct: ["componentId"] }),
      ])
    : [[], []];
  const issuedSet = new Set(issued.map((t) => t.componentId));
  const pickedSet = new Set(picked.map((t) => t.componentId));
  const started = (c: (typeof lined)[number]) => c.operations.some((o) => o.status !== NOT_STARTED) || issuedSet.has(c.id) || pickedSet.has(c.id);
  const label = (c: { tag: string }) => c.tag;

  // ── Pinned routes and tags that stay ──────────────────────────────────
  const pinnedRoutes = new Map<string, number>();
  const takenTags = new Map<number | null, Set<string>>();
  const keep = (c: (typeof lined)[number]) => {
    const set = takenTags.get(c.unitId) ?? new Set<string>();
    set.add(c.tag);
    takenTags.set(c.unitId, set);
  };
  for (const c of lined) {
    const line = targetByNo.get(c.bomItem!.itemNo);
    const changed = line ? changedLineFields(c.bomItem!, line) : null;
    // Invariant 9: the route a part was built on stays, unless its family or variant changed (and it can still be swapped).
    if (c.routeVersionId != null && !changed?.some((f) => f.field === "partFamily" || f.field === "routeVariant")) {
      pinnedRoutes.set(componentKey(c.unitId, c.bomItem!.itemNo), c.routeVersionId);
    }
    // A part that stays as it is (unchanged, or started) keeps its tag; one that is updated in place or retired frees it.
    if (started(c) || (line && changed!.length === 0)) keep(c);
  }

  const mappedIds = targetItems.filter((b) => b.componentTypeId != null).map((b) => b.id);
  const built = await buildComponentRows(tx, {
    familyId: equipment.familyId,
    equipmentId: equipment.id,
    bomItemIds: mappedIds,
    jobId: equipment.jobId,
    opts: { release: true, rules: ctx.rules, pinnedRoutes, takenTags },
  });
  const desired = new Map<string, ComponentRow>(built.rows.map((r) => [componentKey(r.unitId, r.itemNo), r]));
  const existingByKey = new Map(lined.map((c) => [componentKey(c.unitId, c.bomItem!.itemNo), c]));

  // ── Components and their operations ───────────────────────────────────
  const memory = new CancelledMemory(tx, equipment.id, targetByNo);
  const cancelledSeqs = await cancelledOperationSeqs(tx, memory, lined);
  const toCreate: ComponentRow[] = [];
  const flagOps = async (c: (typeof lined)[number], fields: DiffField[]) => {
    const live = c.operations.filter((o) => !o.needsReview);
    rec.add("component", "review", { id: c.id, unitId: c.unitId, label: label(c), fields, status: "STARTED" });
    for (const o of live) {
      await tx.componentOperation.update({ where: { id: o.id }, data: { needsReview: true } });
      rec.add("operation", "review", { id: o.id, unitId: c.unitId, label: `${label(c)} · op ${o.seq}`, fields, status: o.status }, { kind: "OP", id: o.id });
    }
  };

  for (const [key, c] of existingByKey) {
    const d = desired.get(key);
    const line = targetByNo.get(c.bomItem!.itemNo);
    const isStarted = started(c);
    if (!d || !line) {
      // gone
      if (isStarted) {
        await flagOps(c, [{ field: "line", from: "in the BOM", to: "removed or unmapped" }]);
      } else {
        for (const o of c.operations) {
          await tx.componentOperation.update({ where: { id: o.id }, data: retireData });
          rec.add("operation", "retire", { id: o.id, unitId: c.unitId, label: `${label(c)} · op ${o.seq}`, status: o.status }, { kind: "OP", id: o.id });
        }
        await tx.component.update({ where: { id: c.id }, data: { retiredAt: now, retiredReason: reason } });
        rec.add("component", "retire", { id: c.id, unitId: c.unitId, label: label(c), status: "NOT_STARTED" });
      }
      continue;
    }
    const changed = changedLineFields(c.bomItem!, line);
    // The part now follows the target revision's line (its stock and heat history follow the line, not the id).
    if (c.bomItemId !== d.bomItemId) await tx.component.update({ where: { id: c.id }, data: { bomItemId: d.bomItemId } });
    if (changed.length > 0 && isStarted) {
      await flagOps(c, changed);
      continue;
    }
    if (changed.length > 0) {
      await tx.component.update({
        where: { id: c.id },
        data: { tag: d.tag, componentTypeId: d.componentTypeId, routeVersionId: d.routeVersionId, pressureRetaining: d.pressureRetaining },
      });
      rec.add("component", "update", { id: c.id, unitId: c.unitId, label: label(c), fields: changed, status: "NOT_STARTED" });
    }
    await diffOps(tx, rec, c, d, equipment.jobId, retireData, cancelledSeqs.get(c.id) ?? new Set());
  }
  for (const [key, d] of desired) {
    if (!existingByKey.has(key)) {
      toCreate.push(d);
    }
  }
  if (toCreate.length > 0) {
    const created = await writeComponentRows(tx, equipment.jobId, equipment.id, toCreate);
    for (const [i, d] of toCreate.entries()) {
      rec.add("component", "add", { id: created.componentIds[i], unitId: d.unitId, label: d.tag, fields: [{ field: "operations", from: null, to: d.ops.length }] });
      for (const o of d.ops) rec.add("operation", "add", { id: null, unitId: d.unitId, label: `${d.tag} · op ${o.seq}` });
    }
  }

  // ── Assembly steps ────────────────────────────────────────────────────
  const stepsBuilt = await buildAssemblyStepRows(tx, {
    tenantId: ctx.tenantId,
    jobId: equipment.jobId,
    familyId: equipment.familyId,
    unitIds,
    qcpTemplateId: ctx.qcpTemplateId,
    equipmentTypeId: equipment.equipmentTypeId,
    rules: ctx.rules,
    skippedQcp: ctx.skippedQcp,
    equipmentId: equipment.id,
    answers: (equipment.config as Record<string, unknown> | null) ?? {},
    pinnedVersionId: equipment.assemblyTemplateVersionId,
  });
  if (stepsBuilt.version && equipment.assemblyTemplateVersionId == null) {
    await tx.equipment.update({ where: { id: equipment.id }, data: { assemblyTemplateVersionId: stepsBuilt.version.id } });
    await tx.job.updateMany({ where: { id: equipment.jobId, assemblyTemplateVersionId: null }, data: { assemblyTemplateVersionId: stepsBuilt.version.id } });
  }
  await diffSteps(tx, rec, {
    equipmentId: equipment.id,
    unitIds,
    desired: stepsBuilt.rows,
    retireData,
    memory,
  });

  // ── Roll the touched plans up ─────────────────────────────────────────
  if (FEATURES.leanFloor && rec.touched.length > 0) await rollupTouched(tx, actor, rec.touched);

  const totalComponents = await tx.component.count({ where: { ...activeRow, equipmentId: equipment.id } });
  return {
    diff: rec.diff,
    pressureCount: built.pressureCount,
    boundToQcp: stepsBuilt.boundToQcp,
    emptyScopes: stepsBuilt.emptyScopes,
    components: totalComponents,
    operations: await tx.componentOperation.count({ where: { ...activeRow, component: { equipmentId: equipment.id } } }),
    steps: await tx.assemblyStep.count({ where: { ...activeRow, unit: { equipmentId: equipment.id } } }),
    stepsByScope: stepsBuilt.byScope,
  };
}

/** Roll up the plan each touched row feeds (a roll-up that changes nothing writes nothing). */
async function rollupTouched(tx: Tx, actor: Actor, touched: Touch[]): Promise<void> {
  for (const t of touched) {
    if (t.kind === "STEP") await rollupForAssemblyStep(tx, actor, t.id);
    else await rollupForComponentOperation(tx, actor, t.id);
  }
}

// ── Operations ───────────────────────────────────────────────────────────

interface ExistingComponent {
  id: number;
  unitId: number | null;
  tag: string;
  operations: { id: number; seq: number; operationId: number; status: OperationStatus; requiresQc: boolean; qtyPlanned: number | null; needsReview: boolean }[];
}

/** componentId -> the operation seqs cancelled in review whose BOM line is unchanged since (see CancelledMemory). */
async function cancelledOperationSeqs(tx: Tx, memory: CancelledMemory, parts: { id: number; bomItem: { itemNo: number } | null }[]): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  if (parts.length === 0) return out;
  const itemNoOf = new Map(parts.map((c) => [c.id, c.bomItem?.itemNo ?? null]));
  // j5c: history (cancelled rows are what this reads)
  const cancelled = await tx.componentOperation.findMany({
    where: { componentId: { in: parts.map((c) => c.id) }, retiredAt: { not: null }, retiredReason: { startsWith: CANCELLED_IN_REVIEW } },
    select: { componentId: true, seq: true, retiredAt: true },
  });
  for (const o of cancelled) {
    const itemNo = itemNoOf.get(o.componentId);
    if (itemNo == null || !(await memory.lineUnchangedSince(itemNo, o.retiredAt!))) continue;
    const set = out.get(o.componentId) ?? new Set<number>();
    set.add(o.seq);
    out.set(o.componentId, set);
  }
  return out;
}

async function diffOps(
  tx: Tx,
  rec: Recorder,
  c: ExistingComponent,
  d: ComponentRow,
  jobId: number,
  retireData: { retiredAt: Date; retiredReason: string; needsReview: boolean },
  /** Operations of this part cancelled in review whose line has not changed since: not added back. */
  cancelledSeqs: Set<number>,
): Promise<void> {
  const have = new Map(c.operations.map((o) => [o.seq, o]));
  const want = new Map(d.ops.map((o) => [o.seq, o]));
  for (const seq of [...new Set([...have.keys(), ...want.keys()])].sort((a, b) => a - b)) {
    const e = have.get(seq);
    const w = want.get(seq);
    const label = `${c.tag} · op ${seq}`;
    if (e && w) {
      const fields = opFieldChanges(e, w);
      if (fields.length === 0) continue;
      // A started operation is only ever flagged because its part's line changed (flagOps) or the step left the
      // route; a field that differs now (quantity, QC flag from a changed master) does not reopen what Keep settled.
      if (e.status === NOT_STARTED) {
        await tx.componentOperation.update({ where: { id: e.id }, data: { operationId: w.operationId, requiresQc: w.requiresQc, qtyPlanned: w.qtyPlanned } });
        rec.add("operation", "update", { id: e.id, unitId: c.unitId, label, fields, status: e.status }, { kind: "OP", id: e.id });
      }
    } else if (e) {
      if (e.status === NOT_STARTED) {
        await tx.componentOperation.update({ where: { id: e.id }, data: retireData });
        rec.add("operation", "retire", { id: e.id, unitId: c.unitId, label, status: e.status }, { kind: "OP", id: e.id });
      } else if (!e.needsReview) {
        await tx.componentOperation.update({ where: { id: e.id }, data: { needsReview: true } });
        rec.add("operation", "review", { id: e.id, unitId: c.unitId, label, fields: [{ field: "step", from: "in the route", to: "removed" }], status: e.status }, { kind: "OP", id: e.id });
      }
    } else if (w) {
      if (cancelledSeqs.has(seq)) continue;
      const row = await tx.componentOperation.create({
        data: { componentId: c.id, seq: w.seq, operationId: w.operationId, requiresQc: w.requiresQc, ...(w.qtyPlanned != null ? { qtyPlanned: w.qtyPlanned } : {}), jobId },
        select: { id: true },
      });
      rec.add("operation", "add", { id: row.id, unitId: c.unitId, label }, { kind: "OP", id: row.id });
    }
  }
}

function opFieldChanges(e: { operationId: number; requiresQc: boolean; qtyPlanned: number | null }, w: ComponentOpRow): DiffField[] {
  const out: DiffField[] = [];
  if (e.operationId !== w.operationId) out.push({ field: "operation", from: e.operationId, to: w.operationId });
  if (e.requiresQc !== w.requiresQc) out.push({ field: "requiresQc", from: e.requiresQc, to: w.requiresQc });
  if ((e.qtyPlanned ?? null) !== (w.qtyPlanned ?? null)) out.push({ field: "quantity", from: e.qtyPlanned, to: w.qtyPlanned });
  return out;
}

// ── Assembly steps ───────────────────────────────────────────────────────

const stepKey = (unitId: number, templateStepId: number, plannedJointId: number | null, itemNo: number | null) =>
  `${unitId}:${templateStepId}:${plannedJointId ?? ""}:${itemNo ?? ""}`;

export interface StepDiffArgs {
  equipmentId: number;
  unitIds: number[];
  desired: AssemblyStepRow[];
  retireData: { retiredAt: Date; retiredReason: string; needsReview: boolean };
  /** Review Replace: only the steps of these parts. */
  onlyComponentIds?: number[];
  /** A release or check: steps cancelled in review are not added back while what they depend on is unchanged. */
  memory?: CancelledMemory;
}

/** Step rows of a unit in the materialiser's own order, then numbered with its own formula. */
export async function renumberUnitSteps(tx: Tx, unitIds: number[]): Promise<void> {
  if (unitIds.length === 0) return;
  const rows = await tx.assemblyStep.findMany({
    where: { ...activeRow, unitId: { in: unitIds } },
    select: {
      id: true,
      unitId: true,
      templateStepId: true,
      componentId: true,
      templateStep: { select: { seq: true } },
      plannedJoint: { select: { sortOrder: true, id: true } },
    },
  });
  const finalIds: number[] = [];
  const finalSeqs: number[] = [];
  for (const unitId of unitIds) {
    const mine = rows
      .filter((r) => r.unitId === unitId)
      .sort(
        (a, b) =>
          a.templateStep.seq - b.templateStep.seq ||
          a.templateStepId - b.templateStepId ||
          (a.plannedJoint?.sortOrder ?? 0) - (b.plannedJoint?.sortOrder ?? 0) ||
          (a.plannedJoint?.id ?? 0) - (b.plannedJoint?.id ?? 0) ||
          (a.componentId ?? 0) - (b.componentId ?? 0) ||
          a.id - b.id,
      );
    let extra = 0;
    for (let i = 0; i < mine.length; ) {
      let j = i;
      while (j < mine.length && mine[j].templateStepId === mine[i].templateStepId) j++;
      for (let k = i; k < j; k++) {
        finalIds.push(mine[k].id);
        finalSeqs.push(mine[i].templateStep.seq + extra + (k - i));
      }
      extra += Math.max(j - i - 1, 0);
      i = j;
    }
  }
  if (finalIds.length === 0) return;
  // Pass 1 moved every active seq negative (see diffSteps), pass 2 lands here, so the partial unique never collides.
  await tx.$executeRaw`UPDATE assembly_steps s SET seq = v.seq FROM unnest(${finalIds}::int[], ${finalSeqs}::int[]) AS v(id, seq) WHERE s.id = v.id`;
}

export async function diffSteps(tx: Tx, rec: Recorder, args: StepDiffArgs): Promise<void> {
  const itemNoOf = new Map<number, number | null>();
  // j5c: history (every part of the line, retired ones too: a retired part's steps key on its item number)
  const comps = await tx.component.findMany({ where: { equipmentId: args.equipmentId }, select: { id: true, bomItem: { select: { itemNo: true } } } });
  for (const c of comps) itemNoOf.set(c.id, c.bomItem?.itemNo ?? null);
  const only = args.onlyComponentIds ? new Set(args.onlyComponentIds) : null;

  const existing = await tx.assemblyStep.findMany({
    where: { ...activeRow, unit: { equipmentId: args.equipmentId } },
    select: {
      id: true,
      unitId: true,
      templateStepId: true,
      status: true,
      plannedJointId: true,
      componentId: true,
      jointRef: true,
      qcpItemId: true,
      requiresQc: true,
      pressurePart: true,
      role: true,
      qtyPlanned: true,
      needsReview: true,
      templateStep: { select: { activity: true, scope: true } },
    },
  });
  const inScope = <T extends { componentId: number | null }>(r: T) => !only || (r.componentId != null && only.has(r.componentId));
  const keyOf = (r: { unitId: number; templateStepId: number; plannedJointId: number | null; componentId: number | null }) =>
    stepKey(r.unitId, r.templateStepId, r.plannedJointId, r.componentId != null ? (itemNoOf.get(r.componentId) ?? null) : null);

  const have = new Map(existing.filter(inScope).map((r) => [keyOf(r), r]));
  const want = new Map(args.desired.filter(inScope).map((r) => [keyOf(r), r]));
  const steps = await tx.assemblyTemplateStep.findMany({
    where: { id: { in: [...new Set([...existing.map((e) => e.templateStepId), ...args.desired.map((d) => d.templateStepId)])] } },
    select: { id: true, activity: true },
  });
  const activity = new Map(steps.map((s) => [s.id, s.activity]));
  const labelOf = (r: { templateStepId: number; jointRef: string | null }) => `${activity.get(r.templateStepId) ?? "Step"}${r.jointRef ? ` · ${r.jointRef}` : ""}`;

  const cancelledSteps = args.memory
    ? // j5c: history (cancelled rows are what this reads)
      await tx.assemblyStep.findMany({
        where: { unit: { equipmentId: args.equipmentId }, retiredAt: { not: null }, retiredReason: { startsWith: CANCELLED_IN_REVIEW } },
        orderBy: { retiredAt: "desc" },
        select: { unitId: true, templateStepId: true, plannedJointId: true, componentId: true, jointRef: true, qcpItemId: true, requiresQc: true, pressurePart: true, role: true, qtyPlanned: true, retiredAt: true },
      })
    : [];
  // A cancelled row stays cancelled while its part's BOM line is unchanged; a row with no BOM line, while what would be
  // added is exactly what was cancelled.
  const stayCancelled = async (key: string, w: AssemblyStepRow): Promise<boolean> => {
    const c = cancelledSteps.find((r) => keyOf(r) === key);
    if (!c || !args.memory) return false;
    const itemNo = w.componentId != null ? (itemNoOf.get(w.componentId) ?? null) : null;
    return itemNo != null ? args.memory.lineUnchangedSince(itemNo, c.retiredAt!) : stepFieldChanges(c, w).length === 0;
  };

  const adds: AssemblyStepRow[] = [];
  const retireIds: number[] = [];
  const touchedUnits = new Set<number>();
  for (const [key, e] of have) {
    const w = want.get(key);
    const label = labelOf(e);
    if (w) {
      const fields = stepFieldChanges(e, w);
      const movedPart = w.componentId != null && e.componentId !== w.componentId;
      if (movedPart) fields.push({ field: "part", from: e.componentId, to: w.componentId });
      if (fields.length === 0) continue;
      if (e.status === NOT_STARTED) {
        await tx.assemblyStep.update({
          where: { id: e.id },
          data: { jointRef: w.jointRef, qcpItemId: w.qcpItemId, requiresQc: w.requiresQc, pressurePart: w.pressurePart, role: w.role, qtyPlanned: w.qtyPlanned, componentId: w.componentId },
        });
        rec.add("step", "update", { id: e.id, unitId: e.unitId, label, fields, status: e.status }, { kind: "STEP", id: e.id });
      } else if (!e.needsReview) {
        await tx.assemblyStep.update({ where: { id: e.id }, data: { needsReview: true } });
        rec.add("step", "review", { id: e.id, unitId: e.unitId, label, fields, status: e.status }, { kind: "STEP", id: e.id });
      }
    } else if (e.status === NOT_STARTED) {
      retireIds.push(e.id);
      touchedUnits.add(e.unitId);
      rec.add("step", "retire", { id: e.id, unitId: e.unitId, label, status: e.status }, { kind: "STEP", id: e.id });
    } else if (!e.needsReview) {
      await tx.assemblyStep.update({ where: { id: e.id }, data: { needsReview: true } });
      rec.add("step", "review", { id: e.id, unitId: e.unitId, label, fields: [{ field: "step", from: "in the sequence", to: "removed" }], status: e.status }, { kind: "STEP", id: e.id });
    }
  }
  for (const [key, w] of want) {
    if (!have.has(key)) {
      if (await stayCancelled(key, w)) continue;
      adds.push(w);
      touchedUnits.add(w.unitId);
    }
  }
  if (retireIds.length > 0) {
    await tx.assemblyStep.updateMany({ where: { id: { in: retireIds } }, data: args.retireData });
  }
  if (touchedUnits.size === 0) return;
  // Pass 1: every remaining active seq of a touched unit goes negative, so new rows and the final numbering
  // never meet an old value in the partial unique (unit_id, seq) WHERE retired_at IS NULL.
  const units = [...touchedUnits];
  await tx.$executeRaw`UPDATE assembly_steps SET seq = -seq WHERE unit_id = ANY(${units}::int[]) AND retired_at IS NULL AND seq > 0`;
  let temp = 0;
  const created: number[] = [];
  for (const w of adds) {
    const row = await tx.assemblyStep.create({ data: { ...w, seq: -(10_000_000 + ++temp) }, select: { id: true } });
    created.push(row.id);
    rec.add("step", "add", { id: row.id, unitId: w.unitId, label: labelOf(w), fields: [] }, { kind: "STEP", id: row.id });
  }
  await renumberUnitSteps(tx, units);
}

function stepFieldChanges(
  e: { jointRef: string | null; qcpItemId: number | null; requiresQc: boolean; pressurePart: boolean; role: AssemblyStepRole | null; qtyPlanned: number | null },
  w: AssemblyStepRow,
): DiffField[] {
  const out: DiffField[] = [];
  if ((e.jointRef ?? null) !== (w.jointRef ?? null)) out.push({ field: "joint", from: e.jointRef, to: w.jointRef });
  if ((e.qcpItemId ?? null) !== (w.qcpItemId ?? null)) out.push({ field: "qcpItem", from: e.qcpItemId, to: w.qcpItemId });
  if (e.requiresQc !== w.requiresQc) out.push({ field: "requiresQc", from: e.requiresQc, to: w.requiresQc });
  if (e.pressurePart !== w.pressurePart) out.push({ field: "pressurePart", from: e.pressurePart, to: w.pressurePart });
  if ((e.role ?? null) !== (w.role ?? null)) out.push({ field: "role", from: e.role, to: w.role });
  if ((e.qtyPlanned ?? null) !== (w.qtyPlanned ?? null)) out.push({ field: "quantity", from: e.qtyPlanned, to: w.qtyPlanned });
  return out;
}

export { Recorder };
