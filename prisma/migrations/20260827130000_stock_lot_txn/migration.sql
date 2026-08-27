-- B6, Phase 4: real receipt/consumption ledger — `stock_lots` (part + heat +
-- location + qty) and `stock_txns` (ISSUE/RETURN/SCRAP against a lot).
-- Purely additive: no existing table is touched. Receipt itself is a
-- `stock_lots` row, not a txn — see the model's doc comment in schema.prisma.
--
-- Rollback: DROP TABLE stock_txns; DROP TABLE stock_lots; DROP TYPE
-- "StockTxnType"; drop the four added relation fields from
-- prisma/schema.prisma (BomItem.stockLots, ProcurementEvent.stockLots,
-- User.stockTxns, Component.stockTxns). This removes the shortage number
-- only — `bom.read.ts`'s `requiredQty` and everything upstream of it are
-- untouched (task brief's rollback note).

-- CreateEnum
CREATE TYPE "StockTxnType" AS ENUM ('ISSUE', 'RETURN', 'SCRAP');

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" SERIAL NOT NULL,
    "bom_item_id" INTEGER NOT NULL,
    "heat_number" TEXT,
    "location" TEXT NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_procurement_event_id" INTEGER,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_txns" (
    "id" SERIAL NOT NULL,
    "stock_lot_id" INTEGER NOT NULL,
    "type" "StockTxnType" NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" INTEGER NOT NULL,
    "component_id" INTEGER,
    "note" TEXT,

    CONSTRAINT "stock_txns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_lots_bom_item_id_idx" ON "stock_lots"("bom_item_id");

-- CreateIndex
CREATE INDEX "stock_lots_source_procurement_event_id_idx" ON "stock_lots"("source_procurement_event_id");

-- CreateIndex
CREATE INDEX "stock_txns_stock_lot_id_idx" ON "stock_txns"("stock_lot_id");

-- CreateIndex
CREATE INDEX "stock_txns_component_id_idx" ON "stock_txns"("component_id");

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_source_procurement_event_id_fkey" FOREIGN KEY ("source_procurement_event_id") REFERENCES "procurement_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_txns" ADD CONSTRAINT "stock_txns_stock_lot_id_fkey" FOREIGN KEY ("stock_lot_id") REFERENCES "stock_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_txns" ADD CONSTRAINT "stock_txns_by_fkey" FOREIGN KEY ("by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_txns" ADD CONSTRAINT "stock_txns_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE SET NULL ON UPDATE CASCADE;
