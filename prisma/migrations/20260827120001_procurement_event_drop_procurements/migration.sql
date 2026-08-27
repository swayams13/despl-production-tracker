-- B5, Phase 4 (2/2): drop the old `procurements` table + its two enums, now
-- that `scripts/backfill-procurement-events.ts` has synthesized every
-- pre-existing row into `procurement_events` (migration
-- 20260827120000_procurement_event). See that migration's header for why
-- this is split out rather than combined with the CREATE TABLE.
--
-- Do not apply this migration to an environment before running the backfill
-- script against it — this is the actual point of no return for the old
-- flat-status data (once dropped, only `procurement_events` rows remain, and
-- an un-backfilled row's history is gone for good).
--
-- Rollback: recreate `procurements`/`ProcurementStatus`/
-- `MaterialReceivedStatus` (see the previous migration or an earlier commit
-- of prisma/schema.prisma for the exact shape) — there is no data path back
-- from `procurement_events` rows to the old flat shape once this runs.
-- DropForeignKey
ALTER TABLE "procurements" DROP CONSTRAINT "procurements_bom_item_id_fkey";

-- DropTable
DROP TABLE "procurements";

-- DropEnum
DROP TYPE "MaterialReceivedStatus";

-- DropEnum
DROP TYPE "ProcurementStatus";
