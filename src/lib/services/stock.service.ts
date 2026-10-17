import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertClientScope, assertNotClientUser, requireRole, type Actor } from "@/lib/authz";
import { ISSUE_ROLES, LOT_HEAT_ROLES, RECEIVE_ROLES, SCRAP_ROLES } from "@/lib/shared/stores-access";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  receiveStockSchema,
  issueStockSchema,
  recordLotHeatSchema,
  type ReceiveStockInput,
  type IssueStockInput,
  type RecordLotHeatInput,
} from "@/lib/shared/schemas";
import type { StockLot, StockTxn, StockTxnType } from "@/generated/prisma/client";

/**
 * `StockLot` + `StockTxn` (B6, Phase 4) — a real receipt/consumption ledger,
 * so shortage (required qty vs. what's actually on hand) is computable
 * instead of typed. Same role gate and tenant-anchoring pattern as
 * `procurement.service.ts`: ADMIN or PRODUCTION_HEAD, `bom_item`/`stock_lot`
 * carry no tenant_id of their own, so every lookup is anchored through
 * `equipment.job.tenantId`.
 */

/** Receive a lot of stock against a BOM item — creates a `StockLot`. Receipt
 * itself is lot creation, not a `StockTxn` (see the model's doc comment) —
 * avoids a redundant paired row every time. */
export async function receiveStock(actor: Actor, input: ReceiveStockInput): Promise<StockLot> {
  const { bomItemId, heatNumber, location, qty, sourceProcurementEventId } = receiveStockSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ...RECEIVE_ROLES);

  return withTenant(actor.tenantId, async (tx) => {
    const bomItem = await tx.bomItem.findFirst({
      where: { id: bomItemId, equipment: { job: { tenantId: actor.tenantId } } },
      select: { equipment: { select: { job: { select: { clientId: true, id: true } } } } },
    });
    if (!bomItem) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "BomItem", bomItemId });
    assertClientScope(actor, bomItem.equipment.job.clientId);

    if (sourceProcurementEventId != null) {
      const event = await tx.procurementEvent.findFirst({
        where: { id: sourceProcurementEventId, bomItemId },
        select: { id: true },
      });
      if (!event) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcurementEvent", sourceProcurementEventId });
    }

    return audited(tx, actor, async () => {
      const lot = await tx.stockLot.create({
        data: {
          bomItemId,
          heatNumber: heatNumber ?? null,
          location,
          qty,
          sourceProcurementEventId: sourceProcurementEventId ?? null,
          jobId: bomItem.equipment.job.id,
        },
      });
      return {
        result: lot,
        audit: {
          action: "stock.receive",
          entityType: "StockLot",
          entityId: lot.id,
          after: { bomItemId, heatNumber: heatNumber ?? null, location, qty },
          eventType: "StockLotReceived",
          eventPayload: { bomItemId, qty },
        },
      };
    });
  });
}

/**
 * L2.14: add the heat number to a lot that was received without one. The one
 * update `stock_lots` allows (a column grant, with a trigger that lets it go from
 * empty to a value exactly once); everything else stays append-only. The audit row
 * keeps who set it and when. A lot that already has a heat number is QC's to correct.
 */
export async function recordLotHeat(actor: Actor, input: RecordLotHeatInput): Promise<{ stockLotId: number; heatNumber: string }> {
  const { stockLotId, heatNumber } = recordLotHeatSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ...LOT_HEAT_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    await loadLotForMutation(tx, actor, stockLotId); // locks the lot, checks the tenant, scopes the job
    const lot = await tx.stockLot.findUniqueOrThrow({ where: { id: stockLotId }, select: { heatNumber: true, bomItemId: true } });
    if (lot.heatNumber) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: `This lot already has heat number ${lot.heatNumber}. QC corrects a recorded heat number.` });
    }
    // Not after the material has been cut into a part: that would rewrite the trace of finished work
    // (it is QC's to correct once the cutting is recorded, as for a picked heat number).
    const issuedTo = await tx.stockTxn.findMany({ where: { stockLotId, type: "ISSUE", componentId: { not: null } }, select: { componentId: true } });
    const partIds = [...new Set(issuedTo.map((t) => t.componentId!))];
    if (partIds.length) {
      const cut = await tx.componentOperation.count({
        where: { componentId: { in: partIds }, operation: { code: "CUTTING" }, status: { notIn: ["NOT_STARTED", "IN_PROGRESS"] } },
      });
      if (cut > 0) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Material from this lot has already been cut into a part. QC corrects a heat number after that." });
      }
    }
    return audited(tx, actor, async () => {
      await tx.stockLot.update({ where: { id: stockLotId }, data: { heatNumber } });
      return {
        result: { stockLotId, heatNumber },
        audit: {
          action: "stock.recordHeat",
          entityType: "StockLot",
          entityId: stockLotId,
          before: { heatNumber: null },
          after: { heatNumber, bomItemId: lot.bomItemId },
          eventType: "StockLotHeatRecorded",
          eventPayload: { stockLotId, heatNumber },
        },
      };
    });
  });
}

/** Shared tenant-anchored lot lookup + running-available check, used by
 * issue/return/scrap. Returns the lot's `bomItem` clientId for client-scope
 * assertion, and the lot's current available qty (received - issued/scrapped
 * + returned) for the over-issue guard.
 *
 * S21: locked before reading `txns` — same reason `lockComponentOperation
 * ForUpdate`/`lockAssemblyStepForUpdate`/`lockProcessPlanForUpdate` lock
 * their own rows: without it, two concurrent mutations against the same lot
 * (e.g. two `issueStock` calls) can both read the same stale `available`
 * snapshot and both pass `createStockTxn`'s over-issue guard, over-issuing
 * the lot — a real TOCTOU race, not a hypothetical one.
 *
 * NOT a `SELECT ... FOR UPDATE` row lock, unlike those three siblings —
 * Postgres requires UPDATE privilege on the target table for FOR UPDATE
 * (SELECT alone isn't enough), and `stock_lots`, like `stock_txns` and
 * `audit_log`, deliberately grants the app role only `SELECT`+`INSERT`
 * (`ar`, confirmed via `pg_class.relacl`) — an append-only ledger with no
 * legitimate UPDATE path at the ORM level either (a lot's own `qty` is never
 * updated; issue/return/scrap all just append a `StockTxn`). Widening that
 * grant just to support locking would blur a real, deliberate boundary. A
 * transaction-scoped Postgres advisory lock gives the same mutual exclusion
 * per lot with no table privilege requirement at all, and releases
 * automatically at commit/rollback exactly like a row lock would. */
async function loadLotForMutation(tx: Tx, actor: Actor, stockLotId: number) {
  // ponytail: bare stockLotId as the advisory-lock key — the DB's advisory
  // lock key space is global across every table, not scoped to stock_lots,
  // so this only stays collision-free because it's the only advisory lock
  // in the codebase. Namespace with a two-key `pg_advisory_xact_lock(ns,
  // stockLotId)` if a second call site is ever added.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${stockLotId})`;

  const lot = await tx.stockLot.findFirst({
    where: { id: stockLotId, bomItem: { equipment: { job: { tenantId: actor.tenantId } } } },
    select: {
      id: true,
      qty: true,
      jobId: true,
      bomItem: { select: { equipment: { select: { job: { select: { clientId: true } } } } } },
      txns: { select: { type: true, qty: true } },
    },
  });
  if (!lot) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "StockLot", stockLotId });
  assertClientScope(actor, lot.bomItem.equipment.job.clientId);

  // H1: job-level RLS backstop — scope the rest of this transaction to the
  // lot's own job, same pattern as _shared.ts's other lock* helpers.
  await tx.$executeRaw`SELECT set_config('app.job_id', ${String(lot.jobId)}, true)`;

  let available = lot.qty.toNumber();
  for (const t of lot.txns) {
    const q = t.qty.toNumber();
    if (t.type === "RETURN") available += q;
    else available -= q; // ISSUE | SCRAP
  }
  return { available, jobId: lot.jobId };
}

async function createStockTxn(
  actor: Actor,
  input: IssueStockInput,
  type: StockTxnType,
  action: string,
  eventType: string,
  guardOverIssue: boolean,
  roles: readonly (typeof ISSUE_ROLES)[number][] | readonly (typeof SCRAP_ROLES)[number][],
): Promise<StockTxn> {
  const parsed = issueStockSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ...roles);
  return withTenant(actor.tenantId, (tx) => stockTxnTx(tx, actor, parsed, type, action, eventType, guardOverIssue));
}

/** The ledger write itself, inside the caller's transaction (L2.13: issue-and-pick is one transaction). Caller has checked the role. */
async function stockTxnTx(
  tx: Tx,
  actor: Actor,
  input: IssueStockInput,
  type: StockTxnType,
  action: string,
  eventType: string,
  guardOverIssue: boolean,
): Promise<StockTxn> {
  const { stockLotId, qty, componentId, note } = input;
  const { available, jobId } = await loadLotForMutation(tx, actor, stockLotId);
  if (guardOverIssue && qty > available) {
    throw new AppError(ERROR_CODES.INSUFFICIENT_STOCK, { stockLotId, requested: qty, available });
  }

  // A return puts issued material back: it cannot exceed what is out on issue from this lot (and, when
  // it names a part, from that part). Without this a return conjures stock that was never received, and
  // hides a shortage. (L2.14: Stores may now return, so the ledger enforces it, not the screen.)
  if (type === "RETURN") {
    const moves = await tx.stockTxn.findMany({ where: { stockLotId, type: { in: ["ISSUE", "RETURN"] } }, select: { type: true, qty: true, componentId: true } });
    const out = (only?: number) =>
      moves.filter((m) => only == null || m.componentId === only).reduce((n, m) => n + (m.type === "ISSUE" ? m.qty.toNumber() : -m.qty.toNumber()), 0);
    const outLot = out();
    const outPart = componentId != null ? out(componentId) : outLot;
    const cap = Math.min(outLot, outPart);
    if (qty > cap) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { reason: cap > 0 ? `Only ${cap} is out on issue${componentId != null ? " to this part" : ""} from this lot, so that is the most that can be returned.` : "Nothing is out on issue from this lot to return." },
      );
    }
  }

  if (componentId != null) {
    // H1: componentId must belong to the SAME job as the stockLotId being
    // mutated, not merely the same tenant — the gap named in the research
    // ("an issue against Job A's stock lot could be logged against a
    // component belonging to Job B").
    const component = await tx.component.findFirst({ where: { id: componentId, jobId }, select: { id: true } });
    if (!component) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { entity: "Component", componentId, stockLotId },
        "Component does not belong to this stock lot's job.",
      );
    }
  }

  return audited(tx, actor, async () => {
    const txn = await tx.stockTxn.create({
      data: { stockLotId, type, qty, by: actor.userId, componentId: componentId ?? null, note: note ?? null, jobId },
    });
    return {
      result: txn,
      audit: {
        action,
        entityType: "StockTxn",
        entityId: txn.id,
        after: { stockLotId, type, qty, componentId: componentId ?? null, note: note ?? null },
        eventType,
        eventPayload: { stockLotId, type, qty },
      },
    };
  });
}

/** Issue stock from a lot to a component. Refuses if it would drive the
 * lot's available quantity below zero (exact boundary: issuing exactly the
 * available amount succeeds, one more fails). */
export function issueStock(actor: Actor, input: IssueStockInput): Promise<StockTxn> {
  return createStockTxn(actor, input, "ISSUE", "stock.issue", "StockIssued", true, ISSUE_ROLES);
}

/** `issueStock` inside the caller's transaction, for a caller that must make the issue and another write atomic. Same role gate. */
export function issueStockTx(tx: Tx, actor: Actor, input: IssueStockInput): Promise<StockTxn> {
  assertNotClientUser(actor);
  requireRole(actor, ...ISSUE_ROLES);
  return stockTxnTx(tx, actor, issueStockSchema.parse(input), "ISSUE", "stock.issue", "StockIssued", true);
}

/** Return previously-issued stock back to a lot. No over-issue guard — this
 * is adding back, not taking away. */
export function returnStock(actor: Actor, input: IssueStockInput): Promise<StockTxn> {
  return createStockTxn(actor, input, "RETURN", "stock.return", "StockReturned", false, ISSUE_ROLES);
}

/** Scrap stock from a lot. Same over-scrap guard as `issueStock`. */
export function scrapStock(actor: Actor, input: IssueStockInput): Promise<StockTxn> {
  return createStockTxn(actor, input, "SCRAP", "stock.scrap", "StockScrapped", true, SCRAP_ROLES);
}
