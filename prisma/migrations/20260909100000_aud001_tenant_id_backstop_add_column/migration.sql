-- AUD-001 — tenant-grain RLS backstop, step 1 of 3: add the (nullable) column.
--
-- Mirrors the H1 job_id backstop shape (20260905070000 /
-- 20260905080000 / 20260905090000+20260905091500) but one level up: these are
-- the same 28 tables H1 gave a job_id column to (`SELECT ... FROM
-- pg_policies WHERE policyname = 'job_isolation'` — confirmed live against
-- despl_test on 9 Sep 2026, still exactly 28, unchanged from the audit).
-- job_isolation is fail-open by design (see 20260905090000's comment) and
-- was never meant to be the tenant floor — there is currently NO tenant-grain
-- policy on any of these 28 tables at all, proven live in
-- audit/11_DATABASE_AUDIT.md §3.3 (cross-tenant SELECT *and* UPDATE both
-- succeeded with the tenant GUC set correctly, because job_isolation doesn't
-- look at it).
--
-- Nullable and unenforced until step 2 (NOT NULL where the backfill leaves no
-- gaps) — this migration only adds room for the backfill to write into.
-- No RLS yet (step 3).

ALTER TABLE "units" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "bom_revisions" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "bom_items" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "components" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "job_process_edges" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "process_plans" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "weld_joint_welders" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "ndt_results" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "drawing_revisions" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "dispatch_batch_units" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "inspection_parties" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "qcp_items" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "component_operations" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "component_operation_rejections" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "paint_records" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "dft_readings" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "assembly_steps" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "assembly_step_rejections" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "ncrs" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "qcp_executions" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "qcp_item_processes" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "qcp_item_party_codes" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "delay_reasons" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "stock_lots" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "stock_txns" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "procurement_events" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "material_identifications" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "item_tests" ADD COLUMN "tenant_id" INTEGER;

CREATE INDEX "units_tenant_id_idx" ON "units"("tenant_id");
CREATE INDEX "bom_revisions_tenant_id_idx" ON "bom_revisions"("tenant_id");
CREATE INDEX "bom_items_tenant_id_idx" ON "bom_items"("tenant_id");
CREATE INDEX "components_tenant_id_idx" ON "components"("tenant_id");
CREATE INDEX "job_process_edges_tenant_id_idx" ON "job_process_edges"("tenant_id");
CREATE INDEX "process_plans_tenant_id_idx" ON "process_plans"("tenant_id");
CREATE INDEX "weld_joint_welders_tenant_id_idx" ON "weld_joint_welders"("tenant_id");
CREATE INDEX "ndt_results_tenant_id_idx" ON "ndt_results"("tenant_id");
CREATE INDEX "drawing_revisions_tenant_id_idx" ON "drawing_revisions"("tenant_id");
CREATE INDEX "dispatch_batch_units_tenant_id_idx" ON "dispatch_batch_units"("tenant_id");
CREATE INDEX "inspection_parties_tenant_id_idx" ON "inspection_parties"("tenant_id");
CREATE INDEX "qcp_items_tenant_id_idx" ON "qcp_items"("tenant_id");
CREATE INDEX "component_operations_tenant_id_idx" ON "component_operations"("tenant_id");
CREATE INDEX "component_operation_rejections_tenant_id_idx" ON "component_operation_rejections"("tenant_id");
CREATE INDEX "paint_records_tenant_id_idx" ON "paint_records"("tenant_id");
CREATE INDEX "dft_readings_tenant_id_idx" ON "dft_readings"("tenant_id");
CREATE INDEX "assembly_steps_tenant_id_idx" ON "assembly_steps"("tenant_id");
CREATE INDEX "assembly_step_rejections_tenant_id_idx" ON "assembly_step_rejections"("tenant_id");
CREATE INDEX "ncrs_tenant_id_idx" ON "ncrs"("tenant_id");
CREATE INDEX "qcp_executions_tenant_id_idx" ON "qcp_executions"("tenant_id");
CREATE INDEX "qcp_item_processes_tenant_id_idx" ON "qcp_item_processes"("tenant_id");
CREATE INDEX "qcp_item_party_codes_tenant_id_idx" ON "qcp_item_party_codes"("tenant_id");
CREATE INDEX "delay_reasons_tenant_id_idx" ON "delay_reasons"("tenant_id");
CREATE INDEX "stock_lots_tenant_id_idx" ON "stock_lots"("tenant_id");
CREATE INDEX "stock_txns_tenant_id_idx" ON "stock_txns"("tenant_id");
CREATE INDEX "procurement_events_tenant_id_idx" ON "procurement_events"("tenant_id");
CREATE INDEX "material_identifications_tenant_id_idx" ON "material_identifications"("tenant_id");
CREATE INDEX "item_tests_tenant_id_idx" ON "item_tests"("tenant_id");
