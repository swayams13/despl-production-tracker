-- H1 — job-level RLS backstop, step 1 of 4: add the (nullable) column.
-- See docs/mos-blueprint/reference/15_DESPL_MOS_DATA_ARCHITECTURE.md §4.
-- Nullable and unenforced until Task 3 (NOT NULL) — this migration only
-- adds room for the backfill in Task 2 to write into. No RLS yet (Task 4).

ALTER TABLE "units" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "bom_revisions" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "bom_items" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "components" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "job_process_edges" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "process_plans" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "weld_joint_welders" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "ndt_results" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "drawing_revisions" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "dispatch_batch_units" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "inspection_parties" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "qcp_items" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "component_operations" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "component_operation_rejections" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "paint_records" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "dft_readings" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "assembly_steps" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "assembly_step_rejections" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "ncrs" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "qcp_executions" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "qcp_item_processes" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "qcp_item_party_codes" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "delay_reasons" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "stock_lots" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "stock_txns" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "procurement_events" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "material_identifications" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "item_tests" ADD COLUMN "job_id" INTEGER;

CREATE INDEX "units_job_id_idx" ON "units"("job_id");
CREATE INDEX "bom_revisions_job_id_idx" ON "bom_revisions"("job_id");
CREATE INDEX "bom_items_job_id_idx" ON "bom_items"("job_id");
CREATE INDEX "components_job_id_idx" ON "components"("job_id");
CREATE INDEX "job_process_edges_job_id_idx" ON "job_process_edges"("job_id");
CREATE INDEX "process_plans_job_id_idx" ON "process_plans"("job_id");
CREATE INDEX "weld_joint_welders_job_id_idx" ON "weld_joint_welders"("job_id");
CREATE INDEX "ndt_results_job_id_idx" ON "ndt_results"("job_id");
CREATE INDEX "drawing_revisions_job_id_idx" ON "drawing_revisions"("job_id");
CREATE INDEX "dispatch_batch_units_job_id_idx" ON "dispatch_batch_units"("job_id");
CREATE INDEX "inspection_parties_job_id_idx" ON "inspection_parties"("job_id");
CREATE INDEX "qcp_items_job_id_idx" ON "qcp_items"("job_id");
CREATE INDEX "component_operations_job_id_idx" ON "component_operations"("job_id");
CREATE INDEX "component_operation_rejections_job_id_idx" ON "component_operation_rejections"("job_id");
CREATE INDEX "paint_records_job_id_idx" ON "paint_records"("job_id");
CREATE INDEX "dft_readings_job_id_idx" ON "dft_readings"("job_id");
CREATE INDEX "assembly_steps_job_id_idx" ON "assembly_steps"("job_id");
CREATE INDEX "assembly_step_rejections_job_id_idx" ON "assembly_step_rejections"("job_id");
CREATE INDEX "ncrs_job_id_idx" ON "ncrs"("job_id");
CREATE INDEX "qcp_executions_job_id_idx" ON "qcp_executions"("job_id");
CREATE INDEX "qcp_item_processes_job_id_idx" ON "qcp_item_processes"("job_id");
CREATE INDEX "qcp_item_party_codes_job_id_idx" ON "qcp_item_party_codes"("job_id");
CREATE INDEX "delay_reasons_job_id_idx" ON "delay_reasons"("job_id");
CREATE INDEX "stock_lots_job_id_idx" ON "stock_lots"("job_id");
CREATE INDEX "stock_txns_job_id_idx" ON "stock_txns"("job_id");
CREATE INDEX "procurement_events_job_id_idx" ON "procurement_events"("job_id");
CREATE INDEX "material_identifications_job_id_idx" ON "material_identifications"("job_id");
CREATE INDEX "item_tests_job_id_idx" ON "item_tests"("job_id");
