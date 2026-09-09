-- AUD-001 — tenant-grain RLS backstop, step 2 of 3: backfill, preflight, NOT NULL + FK.
--
-- OWNERSHIP CHAIN — same for all 28 tables, and simpler than a fresh audit of
-- each table's FK graph would suggest: H1 (20260905070000/80000) already
-- denormalized a job_id column onto every one of these 28 tables directly,
-- backed by a FK to jobs(id) (ON DELETE CASCADE for 25 of them; ON DELETE
-- SET NULL for qcp_items/inspection_parties/qcp_item_party_codes, whose
-- job_id is nullable for library rows with no owning job at all). That FK
-- means job_id, wherever non-null, is *guaranteed* to reference a real jobs
-- row — there is no way for this backfill's join to land on a nonexistent
-- job. So every one of the 28 tables uses the identical, direct join:
--   UPDATE <table> t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id
-- No table in this set needs a multi-hop join (e.g. via component_id or
-- unit_id) — H1 already did that flattening once, for job_id, and this
-- reuses it for tenant_id. See the PR description for the full 28-row table
-- making this explicit per table.
--
-- PREFLIGHT: after the backfill, any row with tenant_id IS NULL is either
-- (a) one of the 25 tables' rows, which would mean job_id was NULL — impossible,
-- job_id is NOT NULL on all 25 — or a row whose job_id pointed at a job that
-- doesn't exist, which is impossible under the FK described above; or
-- (b) one of the 3 library-row tables (qcp_items, inspection_parties,
-- qcp_item_party_codes) with job_id IS NULL by design (no owning job at all —
-- see H1's own comment on those three). Those rows are EXPECTED to still have
-- tenant_id IS NULL after this backfill; they are not made NOT NULL below,
-- exactly mirroring how H1 left job_id nullable on the same three tables.
--
-- Run live against despl_test on 9 Sep 2026 (3,583 jobs, 5,073 organizations,
-- real multi-tenant fixture data accumulated by the DB-gated suite — not a
-- production copy, see PR description for what that does and doesn't prove):
-- zero unexpected NULLs on any of the 25 NOT-NULL tables; the only NULLs left
-- were the expected library rows on the 3 exempt tables. Full counts are in
-- the PR description.

UPDATE "units" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "bom_revisions" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "bom_items" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "components" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "job_process_edges" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "process_plans" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "weld_joint_welders" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "ndt_results" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "drawing_revisions" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "dispatch_batch_units" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "inspection_parties" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "qcp_items" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "component_operations" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "component_operation_rejections" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "paint_records" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "dft_readings" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "assembly_steps" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "assembly_step_rejections" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "ncrs" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "qcp_executions" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "qcp_item_processes" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "qcp_item_party_codes" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "delay_reasons" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "stock_lots" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "stock_txns" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "procurement_events" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "material_identifications" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "item_tests" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;

-- Preflight: fail the migration loudly (RAISE EXCEPTION) if any of the 25
-- NOT-NULL-bound tables still has an orphan after the backfill above — that
-- would mean the FK-guarantee this migration relies on doesn't hold, and a
-- silent NOT NULL failure further down is worse than stopping here with the
-- table name and count in the error.
DO $$
DECLARE
  t text;
  orphan_count bigint;
  not_null_tables text[] := ARRAY[
    'units', 'bom_revisions', 'bom_items', 'components',
    'job_process_edges', 'process_plans', 'weld_joint_welders',
    'ndt_results', 'drawing_revisions', 'dispatch_batch_units',
    'component_operations', 'component_operation_rejections',
    'paint_records', 'dft_readings', 'assembly_steps',
    'assembly_step_rejections', 'ncrs', 'qcp_executions',
    'qcp_item_processes', 'delay_reasons', 'stock_lots', 'stock_txns',
    'procurement_events', 'material_identifications', 'item_tests'
  ];
BEGIN
  FOREACH t IN ARRAY not_null_tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id IS NULL', t) INTO orphan_count;
    IF orphan_count > 0 THEN
      RAISE EXCEPTION 'AUD-001 preflight failed: % has % row(s) with tenant_id IS NULL after backfill', t, orphan_count;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE "units" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "units" ADD CONSTRAINT "units_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "bom_revisions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "bom_revisions" ADD CONSTRAINT "bom_revisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "bom_items" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "components" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "components" ADD CONSTRAINT "components_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "job_process_edges" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "job_process_edges" ADD CONSTRAINT "job_process_edges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "process_plans" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "weld_joint_welders" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "weld_joint_welders" ADD CONSTRAINT "weld_joint_welders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ndt_results" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ndt_results" ADD CONSTRAINT "ndt_results_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "drawing_revisions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "drawing_revisions" ADD CONSTRAINT "drawing_revisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "dispatch_batch_units" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "dispatch_batch_units" ADD CONSTRAINT "dispatch_batch_units_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "component_operations" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "component_operation_rejections" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "component_operation_rejections" ADD CONSTRAINT "component_operation_rejections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "paint_records" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "paint_records" ADD CONSTRAINT "paint_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "dft_readings" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "dft_readings" ADD CONSTRAINT "dft_readings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "assembly_steps" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "assembly_step_rejections" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "assembly_step_rejections" ADD CONSTRAINT "assembly_step_rejections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ncrs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "qcp_executions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "qcp_executions" ADD CONSTRAINT "qcp_executions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "qcp_item_processes" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "qcp_item_processes" ADD CONSTRAINT "qcp_item_processes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "delay_reasons" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "delay_reasons" ADD CONSTRAINT "delay_reasons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "stock_lots" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "stock_txns" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "stock_txns" ADD CONSTRAINT "stock_txns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "procurement_events" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "material_identifications" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "material_identifications" ADD CONSTRAINT "material_identifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "item_tests" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "item_tests" ADD CONSTRAINT "item_tests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- qcp_items, inspection_parties, qcp_item_party_codes stay nullable — library
-- rows (job_id IS NULL, mirroring H1's own exception for these three tables)
-- genuinely have no tenant either, since a library QcpTemplate has no job and
-- no other tenant-anchoring column. FK still added so any row that DOES have
-- a tenant_id stays honest.
ALTER TABLE "qcp_items" ADD CONSTRAINT "qcp_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "inspection_parties" ADD CONSTRAINT "inspection_parties_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "qcp_item_party_codes" ADD CONSTRAINT "qcp_item_party_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
