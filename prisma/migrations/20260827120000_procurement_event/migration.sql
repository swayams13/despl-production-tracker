-- B5, Phase 4 (1/2): add the append-only `procurement_events` ledger that
-- replaces the mutable, one-row-per-BomItem `procurements` table.
--
-- Deliberately split into two migrations instead of one create+drop, despite
-- the task brief describing a single migration file: `procurements` still
-- has real seeded rows (54 in despl_test at authoring time) and this table
-- is genuinely the riskiest drop in the phase. Dropping it in the same
-- migration that creates the replacement would mean `scripts/backfill-
-- procurement-events.ts` has no window in which BOTH the source table
-- (`procurements`) and the destination table (`procurement_events`) exist —
-- one script run, atomically. Splitting gives that window:
--   1. this migration (create `procurement_events`, `procurements` untouched)
--   2. `scripts/backfill-procurement-events.ts` (dry-run, then real)
--   3. migration 20260827120001_procurement_event_drop_procurements (drop
--      `procurements` + its two enums, once every environment's backfill is
--      verified)
-- `prisma/schema.prisma` already drops the `Procurement` model as of this
-- commit — `procurements` becomes an unmanaged table from Prisma's
-- perspective for the short window between migrations 1 and 2, which is
-- fine: nothing in `src/` reads or writes it through Prisma any more (the
-- backfill script reads it via `$queryRaw`, not the generated client).
--
-- Rollback of this migration alone: DROP TABLE procurement_events; DROP TYPE
-- "ProcurementEventType"; re-add the `procurement` relation to
-- `prisma/schema.prisma`. `procurements` is never touched by this file, so
-- there is nothing to restore on that side.
-- CreateEnum
CREATE TYPE "ProcurementEventType" AS ENUM ('INDENT_RAISED', 'INDENT_APPROVED', 'PO_PLACED', 'RECEIPT');

-- CreateTable
CREATE TABLE "procurement_events" (
    "id" SERIAL NOT NULL,
    "bom_item_id" INTEGER NOT NULL,
    "type" "ProcurementEventType" NOT NULL,
    "qty" DECIMAL(12,3),
    "ref_no" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" INTEGER NOT NULL,

    CONSTRAINT "procurement_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "procurement_events_bom_item_id_idx" ON "procurement_events"("bom_item_id");

-- CreateIndex
CREATE INDEX "procurement_events_bom_item_id_at_idx" ON "procurement_events"("bom_item_id", "at");

-- AddForeignKey
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_by_fkey" FOREIGN KEY ("by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
