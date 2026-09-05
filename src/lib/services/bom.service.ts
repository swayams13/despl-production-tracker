import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertClientScope, assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createBomItemSchema,
  updateBomItemSchema,
  importBomItemsSchema,
  bomImportRowSchema,
  createBomRevisionSchema,
  type CreateBomItemInput,
  type UpdateBomItemInput,
  type ImportBomItemsInput,
  type CreateBomRevisionInput,
  type BomImportRow,
} from "@/lib/shared/schemas";
import type { BomItem, BomRevision } from "@/generated/prisma/client";

/**
 * B4, Phase 4 — manual BOM authoring (`createBomItem`/`updateBomItem`) and
 * bulk spreadsheet import (`importBomItems`), plus the `BomRevision`
 * create-path B3 deferred. `copyBom` (job-intake.service.ts) stays the only
 * OTHER writer of `BomItem` — this file is additive, not a replacement.
 *
 * Role gate throughout: ADMIN/PRODUCTION_HEAD, matching every other Phase-4
 * mutation service after Dispatch 7's fix round (procurement.service.ts,
 * stock.service.ts, drawing.service.ts).
 */

/**
 * `parentBomItemId`'s write-time cycle guard (Dispatch 1 explicitly deferred
 * this to whichever dispatch first writes the field — this one). Mirrors the
 * *read*-side walk `bom-explosion.ts`'s `explodeBomItem` already does, but
 * asks a different question: does setting `bomItemId`'s parent to
 * `parentBomItemId` make `bomItemId` its own ancestor? Walks up from
 * `parentBomItemId` through the equipment's existing `parentBomItemId` chain;
 * hitting `bomItemId` (or `bomItemId === parentBomItemId` directly) is a
 * cycle. `bomItemId` is `null` on create — a brand-new row can't yet be
 * anyone's ancestor, so only "does the parent exist in this equipment" is
 * checked.
 *
 * Task review Important #3: throws `BOM_PARENT_WOULD_CYCLE`, not
 * `BOM_CYCLE_DETECTED` — the latter is `bom-explosion.ts`'s read-side
 * defensive throw against a chain the DB already got wrong (500, "malformed
 * data, contact an administrator"). This is an ordinary write-time refusal a
 * Production Head can act on directly ("pick a different parent"), not
 * malformed data, so it gets its own code/copy/status (409).
 */
async function assertParentValid(
  tx: Tx,
  equipmentId: number,
  bomItemId: number | null,
  parentBomItemId: number,
): Promise<void> {
  if (bomItemId != null && parentBomItemId === bomItemId) {
    throw new AppError(ERROR_CODES.BOM_PARENT_WOULD_CYCLE, { bomItemId, parentBomItemId });
  }

  const siblings = await tx.bomItem.findMany({
    where: { equipmentId },
    select: { id: true, parentBomItemId: true },
  });
  const byId = new Map(siblings.map((s) => [s.id, s.parentBomItemId]));
  if (!byId.has(parentBomItemId)) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomItem", parentBomItemId });
  }

  let current: number | null = parentBomItemId;
  const visited = new Set<number>();
  while (current != null) {
    if (bomItemId != null && current === bomItemId) {
      throw new AppError(ERROR_CODES.BOM_PARENT_WOULD_CYCLE, { bomItemId, parentBomItemId, cycleAt: current });
    }
    if (visited.has(current)) break; // malformed pre-existing chain — not this call's problem to diagnose further
    visited.add(current);
    current = byId.get(current) ?? null;
  }
}

/** Shared tenant anchor for a target equipment — `bom_items`/`bom_revisions` carry
 * no tenant_id of their own, so every lookup goes through `equipment.job.tenantId`
 * (same pattern as `recordMtc`/`createDrawingRevision`). */
async function loadEquipment(tx: Tx, actor: Actor, equipmentId: number) {
  const equipment = await tx.equipment.findFirst({
    where: { id: equipmentId, job: { tenantId: actor.tenantId } },
    select: { job: { select: { clientId: true, id: true } } },
  });
  if (!equipment) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Equipment", equipmentId });
  assertClientScope(actor, equipment.job.clientId);
  return equipment;
}

async function assertBomRevisionValid(tx: Tx, equipmentId: number, bomRevisionId: number): Promise<void> {
  const revision = await tx.bomRevision.findFirst({ where: { id: bomRevisionId, equipmentId } });
  if (!revision) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomRevision", bomRevisionId });
}

export async function createBomItem(actor: Actor, input: CreateBomItemInput): Promise<BomItem> {
  const parsed = createBomItemSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const equipment = await loadEquipment(tx, actor, parsed.equipmentId);
    if (parsed.bomRevisionId != null) await assertBomRevisionValid(tx, parsed.equipmentId, parsed.bomRevisionId);
    if (parsed.parentBomItemId != null) await assertParentValid(tx, parsed.equipmentId, null, parsed.parentBomItemId);

    return audited(tx, actor, async () => {
      const item = await tx.bomItem.create({ data: { ...parsed, jobId: equipment.job.id } });
      return {
        result: item,
        audit: {
          action: "bom.createItem",
          entityType: "BomItem",
          entityId: item.id,
          after: parsed,
          eventType: "BomItemCreated",
          eventPayload: { equipmentId: parsed.equipmentId, itemNo: parsed.itemNo, partName: parsed.partName },
        },
      };
    });
  });
}

export async function updateBomItem(actor: Actor, bomItemId: number, input: UpdateBomItemInput): Promise<BomItem> {
  const parsed = updateBomItemSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const existing = await tx.bomItem.findFirst({
      where: { id: bomItemId, equipment: { job: { tenantId: actor.tenantId } } },
      select: {
        equipmentId: true,
        itemNo: true,
        blockNo: true,
        partName: true,
        description: true,
        material: true,
        sourceQty: true,
        qtyPer: true,
        uom: true,
        unit: true,
        componentTypeId: true,
        remarks: true,
        parentBomItemId: true,
        bomRevisionId: true,
        equipment: { select: { job: { select: { clientId: true } } } },
      },
    });
    if (!existing) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomItem", bomItemId });
    assertClientScope(actor, existing.equipment.job.clientId);

    if (parsed.bomRevisionId != null) await assertBomRevisionValid(tx, existing.equipmentId, parsed.bomRevisionId);
    if (parsed.parentBomItemId != null) {
      await assertParentValid(tx, existing.equipmentId, bomItemId, parsed.parentBomItemId);
    }

    const { equipment: _equipment, ...before } = existing;

    return audited(tx, actor, async () => {
      const item = await tx.bomItem.update({ where: { id: bomItemId }, data: parsed });
      return {
        result: item,
        audit: {
          action: "bom.updateItem",
          entityType: "BomItem",
          entityId: item.id,
          before,
          after: parsed,
          eventType: "BomItemUpdated",
          eventPayload: { bomItemId },
        },
      };
    });
  });
}

/**
 * Task review Important #1: this repo's own real BOM data
 * (`seed/despl-320-bom-items.json`, read by `scripts/seed-despl320-bom.ts`)
 * is shaped `{itemNo, partName, description, material, qty, unit, remarks}`
 * — `qty`, not `sourceQty` — and a real spreadsheet export routinely carries
 * extra columns `bomImportRowSchema` doesn't model at all. Normalizes each
 * row's keys (trim/lowercase/strip separators, so "Item No", "item_no",
 * "ItemNo" all match one alias) and maps common real-world header variants
 * onto the schema's canonical field names before validation ever sees the
 * row. An unrecognized column is dropped here — and `bomImportRowSchema` is
 * non-`.strict()` as a second line of defense — rather than failing the
 * whole row.
 */
const IMPORT_HEADER_ALIASES: Record<string, keyof BomImportRow> = {
  itemno: "itemNo",
  srno: "itemNo",
  sno: "itemNo",
  blockno: "blockNo",
  partname: "partName",
  description: "description",
  material: "material",
  sourceqty: "sourceQty",
  qty: "sourceQty",
  quantity: "sourceQty",
  qtyper: "qtyPer",
  uom: "uom",
  unit: "unit",
  remarks: "remarks",
  notes: "remarks",
  parentbomitemid: "parentBomItemId",
};

function normalizeImportRow(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const norm = rawKey.trim().toLowerCase().replace(/[\s_.-]+/g, "");
    const canonical = IMPORT_HEADER_ALIASES[norm];
    if (canonical) out[canonical] = value;
  }
  return out;
}

/** ponytail: a flat row-count cap, not chunked sub-transactions — a real BOM
 * workbook runs to hundreds of rows, not tens of thousands; refusing upfront
 * with a clear reason is a smaller diff than a batching scheme, and cheaper
 * than finding out mid-import. Raise (or replace with real chunking) if a
 * genuinely larger single import shows up. */
const IMPORT_MAX_ROWS = 1000;

export interface BomImportFailure {
  row: number;
  error: string;
}

export interface ImportBomItemsResult {
  created: BomItem[];
  failures: BomImportFailure[];
}

/**
 * Bulk create from a parsed CSV/XLSX (rows already turned into plain objects
 * by the caller — `bom-panel.tsx`'s import control, via `xlsx`). Every row is
 * validated and created independently: one malformed row is reported by
 * 1-based row number and reason, the rest of the batch still lands. Never a
 * silent partial success — `failures` is always returned alongside `created`
 * so the caller can report both.
 */
export async function importBomItems(actor: Actor, input: ImportBomItemsInput): Promise<ImportBomItemsResult> {
  const { equipmentId, bomRevisionId, rows } = importBomItemsSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  // Task review Important #4: refuse an oversized file upfront rather than
  // discovering the transaction timeout mid-import.
  if (rows.length > IMPORT_MAX_ROWS) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { rowCount: rows.length, max: IMPORT_MAX_ROWS },
      `This file has ${rows.length} rows — imports are capped at ${IMPORT_MAX_ROWS} at a time. Split it into smaller files.`);
  }

  return withTenant(
    actor.tenantId,
    async (tx) => {
      const equipment = await loadEquipment(tx, actor, equipmentId);
      if (bomRevisionId != null) await assertBomRevisionValid(tx, equipmentId, bomRevisionId);

      const created: BomItem[] = [];
      const failures: BomImportFailure[] = [];

      for (let i = 0; i < rows.length; i++) {
        const rowNo = i + 1;
        const parsedRow = bomImportRowSchema.safeParse(normalizeImportRow(rows[i]));
        if (!parsedRow.success) {
          failures.push({ row: rowNo, error: parsedRow.error.issues.map((iss) => iss.message).join("; ") });
          continue;
        }
        const data = { ...parsedRow.data, equipmentId, bomRevisionId: bomRevisionId ?? null, jobId: equipment.job.id };

        try {
          if (data.parentBomItemId != null) {
            await assertParentValid(tx, equipmentId, null, data.parentBomItemId);
          }
          const item = await audited(tx, actor, async () => {
            const createdRow = await tx.bomItem.create({ data });
            return {
              result: createdRow,
              audit: {
                action: "bom.importItem",
                entityType: "BomItem",
                entityId: createdRow.id,
                after: data,
                eventType: "BomItemImported",
                eventPayload: { equipmentId, itemNo: data.itemNo, row: rowNo },
              },
            };
          });
          created.push(item);
        } catch (e) {
          failures.push({ row: rowNo, error: e instanceof AppError ? e.message : "Could not create this row." });
        }
      }

      return { created, failures };
    },
    // Task review Important #4: a real 200-300 row import (2 round-trips per
    // row: create + audit insert, plus a findMany for any row with a parent)
    // over real network latency plausibly exceeds even the client-wide 20s
    // default (src/lib/db.ts) — 2 minutes gives real headroom without
    // chunking into sub-transactions, which would reintroduce the
    // whole-batch-rollback risk this function's per-row try/catch exists to
    // avoid (a chunk boundary mid-batch is itself a partial-rollback hazard).
    { timeoutMs: 120_000 },
  );
}

/**
 * Issue a new `BomRevision` for an equipment (B4, Phase 4 — B3 deferred this
 * create-path). `BomRevisionStatus` is DRAFT/RELEASED only — unlike
 * `DrawingRevision`, there is no SUPERSEDED status to flip a prior release
 * to. Supersession discipline here is narrower but equivalent in effect: at
 * most one RELEASED revision per equipment at a time, and issuing a new
 * RELEASED revision steps the prior RELEASED row down to DRAFT rather than
 * deleting it — it stays queryable (invariant #9), it just stops being
 * "current." Same monotonicity guard as `createDrawingRevision`
 * (`revisionNo` must be strictly greater than the equipment's current
 * highest) so a typo'd lower/duplicate number can't strand the true current
 * revision.
 */
export async function createBomRevision(actor: Actor, input: CreateBomRevisionInput): Promise<BomRevision> {
  const { equipmentId, revisionNo, status } = createBomRevisionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const equipment = await loadEquipment(tx, actor, equipmentId);

    const highest = await tx.bomRevision.findFirst({
      where: { equipmentId },
      orderBy: { revisionNo: "desc" },
      select: { revisionNo: true },
    });
    if (highest && revisionNo <= highest.revisionNo) {
      throw new AppError(ERROR_CODES.BOM_REVISION_NOT_INCREASING, {
        equipmentId,
        revisionNo,
        currentHighestRevisionNo: highest.revisionNo,
      });
    }

    const priorReleased = status === "RELEASED"
      ? await tx.bomRevision.findFirst({ where: { equipmentId, status: "RELEASED" }, select: { id: true } })
      : null;

    return audited(tx, actor, async () => {
      if (priorReleased) {
        await tx.bomRevision.update({ where: { id: priorReleased.id }, data: { status: "DRAFT" } });
      }
      const revision = await tx.bomRevision.create({
        data: {
          equipmentId,
          revisionNo,
          status,
          createdBy: actor.userId,
          releasedAt: status === "RELEASED" ? new Date() : null,
          jobId: equipment.job.id,
        },
      });
      return {
        result: revision,
        audit: {
          action: "bom.createRevision",
          entityType: "BomRevision",
          entityId: revision.id,
          before: priorReleased ? { steppedDownRevisionId: priorReleased.id } : undefined,
          after: { equipmentId, revisionNo, status, releasedAt: revision.releasedAt },
          eventType: "BomRevisionCreated",
          eventPayload: { equipmentId, revisionNo, status },
        },
      };
    });
  });
}
