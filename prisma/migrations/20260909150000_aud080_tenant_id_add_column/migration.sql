-- AUD-080 — step 2 of 5: add the (nullable) tenant_id column.
--
-- Mirrors 20260909100000_aud001_tenant_id_backstop_add_column exactly, one
-- level down for the eight strict (job_id NOT NULL) tables plus the one
-- library-exempt table (qcp_templates, job_id nullable — same shape as
-- qcp_items/inspection_parties/qcp_item_party_codes in the AUD-001 batch).
-- Nullable and unenforced until step 3 (NOT NULL where the backfill leaves
-- no gaps).

ALTER TABLE "equipments" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "packages" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "job_processes" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "schedule_runs" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "weld_joints" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "weld_logs" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "assembly_drawings" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "dispatch_batches" ADD COLUMN "tenant_id" INTEGER;
ALTER TABLE "qcp_templates" ADD COLUMN "tenant_id" INTEGER;

CREATE INDEX "equipments_tenant_id_idx" ON "equipments"("tenant_id");
CREATE INDEX "packages_tenant_id_idx" ON "packages"("tenant_id");
CREATE INDEX "job_processes_tenant_id_idx" ON "job_processes"("tenant_id");
CREATE INDEX "schedule_runs_tenant_id_idx" ON "schedule_runs"("tenant_id");
CREATE INDEX "weld_joints_tenant_id_idx" ON "weld_joints"("tenant_id");
CREATE INDEX "weld_logs_tenant_id_idx" ON "weld_logs"("tenant_id");
CREATE INDEX "assembly_drawings_tenant_id_idx" ON "assembly_drawings"("tenant_id");
CREATE INDEX "dispatch_batches_tenant_id_idx" ON "dispatch_batches"("tenant_id");
CREATE INDEX "qcp_templates_tenant_id_idx" ON "qcp_templates"("tenant_id");
