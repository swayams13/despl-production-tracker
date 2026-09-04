-- S21 (Gate 2): database integrity.
--
-- 1. A BomItem's item_no must be unique within its own bom_revision_id.
--    Replaces the plain index on bom_revision_id (this composite covers the
--    same leading-column lookups). NULL bom_revision_id rows are exempt —
--    Postgres treats NULL as distinct per row, so pre-B3-backfill stragglers
--    (if any remain) can't retroactively violate this.
-- 2. Index both lead_time_process_seq columns (OperationRef,
--    AssemblyTemplateStep) — _shared.ts's numeric-join gates
--    (loadMappedOps / assertNoOpenNcr) filter on this column on every
--    submitProcess/verifyProcess call.

-- DropIndex
DROP INDEX "bom_items_bom_revision_id_idx";

-- CreateIndex
CREATE INDEX "assembly_template_steps_lead_time_process_seq_idx" ON "assembly_template_steps"("lead_time_process_seq");

-- CreateIndex
CREATE UNIQUE INDEX "bom_items_bom_revision_id_item_no_key" ON "bom_items"("bom_revision_id", "item_no");

-- CreateIndex
CREATE INDEX "operation_refs_lead_time_process_seq_idx" ON "operation_refs"("lead_time_process_seq");
