-- B5, Phase 4 (2/2): drop the old `procurements` table + its two enums.
-- Backfills every pre-existing row into `procurement_events` itself (see the
-- fix-wave note below) before dropping — no separate script run required.
-- See migration 20260827120000_procurement_event's header for why the
-- create and the drop are still split into two migrations.
--
-- This is the actual point of no return for the old flat-status data (once
-- dropped, only `procurement_events` rows remain).
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
--
-- Fix wave, Phase 4 (Critical #2): a doc-comment guard alone still isn't
-- enough — the "run the backfill first" instruction had no way to actually
-- run in an unattended `prisma migrate deploy` pass, so on any environment
-- with real pre-existing `procurements` rows (confirmed: 54 in despl_test)
-- the guard below fired, aborted the deploy, and left THIS migration
-- recorded as failed — blocking every future `prisma migrate deploy` until
-- someone manually intervened. The block immediately below folds
-- `scripts/backfill-procurement-events.ts`'s logic into this migration
-- itself (plain SQL, runs first) so the guard's precondition is now always
-- satisfied by the migration alone. The standalone script stays as a
-- diagnostic/dry-run tool; it is no longer load-bearing for a fresh deploy.
--
-- Same event-per-date-field rules as the script:
--   indent_date    -> INDENT_RAISED  (ref_no = indent_no)
--   approved_date  -> INDENT_APPROVED
--   po_date        -> PO_PLACED      (ref_no = po_no)
--   received_date  -> RECEIPT, qty = the BomItem's qty_per, but ONLY when
--                      received_status = 'RECEIVED' — a partial receipt
--                      never had a real number to recover, so qty stays NULL.
-- `by`: each row's own tenant's admin@despl.local user (same account the
-- seed importer runs as). If a tenant with procurement history has no such
-- user, fail loudly here rather than silently skipping it — the first DO
-- block below raises before any row is written.
DO $$
DECLARE
  missing_admin_count integer;
BEGIN
  SELECT count(DISTINCT j."tenant_id") INTO missing_admin_count
  FROM "procurements" p
  JOIN "bom_items" bi ON bi."id" = p."bom_item_id"
  JOIN "equipments" eq ON eq."id" = bi."equipment_id"
  JOIN "jobs" j ON j."id" = eq."job_id"
  LEFT JOIN "users" u ON u."tenant_id" = j."tenant_id" AND u."email" = 'admin@despl.local'
  WHERE (p."indent_date" IS NOT NULL OR p."approved_date" IS NOT NULL
         OR p."po_date" IS NOT NULL OR p."received_date" IS NOT NULL)
    AND u."id" IS NULL;
  IF missing_admin_count > 0 THEN
    RAISE EXCEPTION 'procurement_event_drop_procurements backfill: % tenant(s) with procurement history have no admin@despl.local user to attribute ProcurementEvent.by to', missing_admin_count;
  END IF;
END $$;

WITH tenant_of_bom_item AS (
  SELECT bi."id" AS bom_item_id, j."tenant_id"
  FROM "bom_items" bi
  JOIN "equipments" eq ON eq."id" = bi."equipment_id"
  JOIN "jobs" j ON j."id" = eq."job_id"
), admin_of_tenant AS (
  SELECT "tenant_id", "id" AS user_id
  FROM "users"
  WHERE "email" = 'admin@despl.local'
), planned AS (
  SELECT p."bom_item_id" AS bom_item_id, 'INDENT_RAISED'::"ProcurementEventType" AS type,
         NULL::DECIMAL(12,3) AS qty, p."indent_no" AS ref_no, p."indent_date" AS at
  FROM "procurements" p WHERE p."indent_date" IS NOT NULL
  UNION ALL
  SELECT p."bom_item_id", 'INDENT_APPROVED'::"ProcurementEventType", NULL, NULL, p."approved_date"
  FROM "procurements" p WHERE p."approved_date" IS NOT NULL
  UNION ALL
  SELECT p."bom_item_id", 'PO_PLACED'::"ProcurementEventType", NULL, p."po_no", p."po_date"
  FROM "procurements" p WHERE p."po_date" IS NOT NULL
  UNION ALL
  SELECT p."bom_item_id", 'RECEIPT'::"ProcurementEventType",
         CASE WHEN p."received_status" = 'RECEIVED' THEN bi."qty_per" ELSE NULL END,
         NULL, p."received_date"
  FROM "procurements" p
  JOIN "bom_items" bi ON bi."id" = p."bom_item_id"
  WHERE p."received_date" IS NOT NULL
)
INSERT INTO "procurement_events" ("bom_item_id", "type", "qty", "ref_no", "at", "by")
SELECT pl.bom_item_id, pl.type, pl.qty, pl.ref_no, pl.at, a.user_id
FROM planned pl
JOIN tenant_of_bom_item t ON t.bom_item_id = pl.bom_item_id
JOIN admin_of_tenant a ON a."tenant_id" = t."tenant_id"
-- Idempotent, same as the standalone script: skip any bom_item_id that
-- already has at least one procurement_events row (e.g. an environment
-- where the standalone script was already run --apply before this
-- migration landed).
WHERE NOT EXISTS (
  SELECT 1 FROM "procurement_events" pe WHERE pe."bom_item_id" = pl.bom_item_id
);

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
