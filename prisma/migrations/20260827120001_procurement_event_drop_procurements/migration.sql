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
--
-- Self-guard (task review C1): Railway's `preDeployCommand` is an unattended
-- `prisma migrate deploy`, which applies every pending migration in one pass
-- — including this one right after the create-migration, with no chance for
-- a human (or `scripts/backfill-procurement-events.ts`) to run in between.
-- A doc comment saying "run the backfill first" cannot stop that pipeline;
-- this DO block can. It aborts the whole migration — leaving `procurements`
-- intact — if any row that actually carries procurement history has no
-- corresponding `procurement_events` row yet.
DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT count(*) INTO missing_count
  FROM "procurements" p
  WHERE (p."indent_date" IS NOT NULL OR p."approved_date" IS NOT NULL
         OR p."po_date" IS NOT NULL OR p."received_date" IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM "procurement_events" pe WHERE pe."bom_item_id" = p."bom_item_id"
    );
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'procurement_event_drop_procurements: % procurements row(s) carry indent/PO/receipt dates with no matching procurement_events row — run scripts/backfill-procurement-events.ts --apply before this migration', missing_count;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "procurements" DROP CONSTRAINT "procurements_bom_item_id_fkey";

-- DropTable
DROP TABLE "procurements";

-- DropEnum
DROP TYPE "MaterialReceivedStatus";

-- DropEnum
DROP TYPE "ProcurementStatus";
