-- H1 — job-level RLS backstop, step 2 of 4: NOT NULL + FK, only after
-- scripts/h1-backfill-job-ids.ts confirmed zero NULLs (excluding library
-- QcpItem/InspectionParty/QcpItemPartyCode rows) and zero dual-path mismatches.

ALTER TABLE "units" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "units" ADD CONSTRAINT "units_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "bom_revisions" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "bom_revisions" ADD CONSTRAINT "bom_revisions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "bom_items" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "components" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "components" ADD CONSTRAINT "components_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "job_process_edges" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "job_process_edges" ADD CONSTRAINT "job_process_edges_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "process_plans" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "weld_joint_welders" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "weld_joint_welders" ADD CONSTRAINT "weld_joint_welders_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ndt_results" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "ndt_results" ADD CONSTRAINT "ndt_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "drawing_revisions" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "drawing_revisions" ADD CONSTRAINT "drawing_revisions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "dispatch_batch_units" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "dispatch_batch_units" ADD CONSTRAINT "dispatch_batch_units_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "component_operations" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "component_operation_rejections" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "component_operation_rejections" ADD CONSTRAINT "component_operation_rejections_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "paint_records" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "paint_records" ADD CONSTRAINT "paint_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "dft_readings" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "dft_readings" ADD CONSTRAINT "dft_readings_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "assembly_steps" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "assembly_step_rejections" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "assembly_step_rejections" ADD CONSTRAINT "assembly_step_rejections_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ncrs" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "qcp_executions" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "qcp_executions" ADD CONSTRAINT "qcp_executions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "qcp_item_processes" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "qcp_item_processes" ADD CONSTRAINT "qcp_item_processes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "delay_reasons" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "delay_reasons" ADD CONSTRAINT "delay_reasons_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "stock_lots" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "stock_txns" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "stock_txns" ADD CONSTRAINT "stock_txns_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "procurement_events" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "procurement_events" ADD CONSTRAINT "procurement_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "material_identifications" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "material_identifications" ADD CONSTRAINT "material_identifications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "item_tests" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "item_tests" ADD CONSTRAINT "item_tests_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- qcp_items, inspection_parties, and qcp_item_party_codes stay nullable —
-- library rows (jobId IS NULL on their parent QcpTemplate/QcpItem) genuinely
-- have no job. qcp_item_party_codes confirmed by a real migrate-deploy
-- failure: 413 rows, all children of library QcpItem rows.
ALTER TABLE "qcp_items" ADD CONSTRAINT "qcp_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "inspection_parties" ADD CONSTRAINT "inspection_parties_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "qcp_item_party_codes" ADD CONSTRAINT "qcp_item_party_codes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE SET NULL;
