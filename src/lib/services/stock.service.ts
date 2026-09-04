import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertClientScope, assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { receiveStockSchema, issueStockSchema, type ReceiveStockInput, type IssueStockInput } from "@/lib/shared/schemas";
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
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const bomItem = await tx.bomItem.findFirst({
      where: { id: bomItemId, equipment: { job: { tenantId: actor.tenantId } } },
      select: { equipment: { select: { job: { select: { clientId: true } } } } },
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
        data: { bomItemId, heatNumber: heatNumber ?? null, location, qty, sourceProcurementEventId: sourceProcurementEventId ?? null },
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
      bomItem: { select: { equipment: { select: { job: { select: { clientId: true } } } } } },
      txns: { select: { type: true, qty: true } },
    },
  });
  if (!lot) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "StockLot", stockLotId });
  assertClientScope(actor, lot.bomItem.equipment.job.clientId);

  let available = lot.qty.toNumber();
  for (const t of lot.txns) {
    const q = t.qty.toNumber();
    if (t.type === "RETURN") available += q;
    else available -= q; // ISSUE | SCRAP
  }
  return { available };
}

async function createStockTxn(
  actor: Actor,
  input: IssueStockInput,
  type: StockTxnType,
  action: string,
  eventType: string,
  guardOverIssue: boolean,
): Promise<StockTxn> {
  const { stockLotId, qty, componentId, note } = issueStockSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const { available } = await loadLotForMutation(tx, actor, stockLotId);
    if (guardOverIssue && qty > available) {
      throw new AppError(ERROR_CODES.INSUFFICIENT_STOCK, { stockLotId, requested: qty, available });
    }

    if (componentId != null) {
      const component = await tx.component.findFirst({
        where: { id: componentId, equipment: { job: { tenantId: actor.tenantId } } },
        select: { id: true },
      });
      if (!component) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Component", componentId });
    }

    return audited(tx, actor, async () => {
      const txn = await tx.stockTxn.create({
        data: { stockLotId, type, qty, by: actor.userId, componentId: componentId ?? null, note: note ?? null },
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
  });
}

/** Issue stock from a lot to a component. Refuses if it would drive the
 * lot's available quantity below zero (exact boundary: issuing exactly the
 * available amount succeeds, one more fails). */
export function issueStock(actor: Actor, input: IssueStockInput): Promise<StockTxn> {
  return createStockTxn(actor, input, "ISSUE", "stock.issue", "StockIssued", true);
}

/** Return previously-issued stock back to a lot. No over-issue guard — this
 * is adding back, not taking away. */
export function returnStock(actor: Actor, input: IssueStockInput): Promise<StockTxn> {
  return createStockTxn(actor, input, "RETURN", "stock.return", "StockReturned", false);
}

/** Scrap stock from a lot. Same over-scrap guard as `issueStock`. */
export function scrapStock(actor: Actor, input: IssueStockInput): Promise<StockTxn> {
  return createStockTxn(actor, input, "SCRAP", "stock.scrap", "StockScrapped", true);
}
