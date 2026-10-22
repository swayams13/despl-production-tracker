-- J5c: a later BOM revision or weld-map change updates not-started floor rows and flags started ones; nothing is deleted
-- (invariant 6). A row that is no longer wanted is retired (retired_at + reason); a started row whose BOM line changed or
-- vanished is kept and flagged needs_review until Engineering or the Production Head resolves it. Additive; no backfill.
-- (Timestamps are TIMESTAMP(3) like every Prisma DateTime in this schema.)

ALTER TABLE "components"
  ADD COLUMN "retired_at" TIMESTAMP(3),
  ADD COLUMN "retired_reason" TEXT;
ALTER TABLE "components" ADD CONSTRAINT "components_retired_check"
  CHECK (("retired_at" IS NULL) = ("retired_reason" IS NULL));

ALTER TABLE "component_operations"
  ADD COLUMN "retired_at" TIMESTAMP(3),
  ADD COLUMN "retired_reason" TEXT,
  ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_retired_check"
  CHECK (("retired_at" IS NULL) = ("retired_reason" IS NULL) AND NOT ("needs_review" AND "retired_at" IS NOT NULL));

ALTER TABLE "assembly_steps"
  ADD COLUMN "retired_at" TIMESTAMP(3),
  ADD COLUMN "retired_reason" TEXT,
  ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_retired_check"
  CHECK (("retired_at" IS NULL) = ("retired_reason" IS NULL) AND NOT ("needs_review" AND "retired_at" IS NOT NULL));

-- Replace adds a row with the same key as the one it retires, so the full unique indexes become partial (active rows only).
DROP INDEX "components_unit_id_tag_key";
CREATE UNIQUE INDEX "components_unit_id_tag_active_key" ON "components"("unit_id", "tag") WHERE "retired_at" IS NULL;

DROP INDEX "components_equipment_id_tag_equipment_grain_key";
CREATE UNIQUE INDEX "components_equipment_id_tag_equipment_grain_key"
  ON "components"("equipment_id", "tag") WHERE "unit_id" IS NULL AND "retired_at" IS NULL;

DROP INDEX "component_operations_component_id_seq_key";
CREATE UNIQUE INDEX "component_operations_component_id_seq_key" ON "component_operations"("component_id", "seq") WHERE "retired_at" IS NULL;

DROP INDEX "assembly_steps_unit_id_seq_key";
CREATE UNIQUE INDEX "assembly_steps_unit_id_seq_key" ON "assembly_steps"("unit_id", "seq") WHERE "retired_at" IS NULL;

-- Retired rows leave the progress percentage (same body as 20260905020000 / 20260908100000 plus the retired_at predicates).
-- CREATE OR REPLACE keeps the grant to despl_web/despl_app.
CREATE OR REPLACE VIEW v_process_plan_percent
WITH (security_invoker = true) AS
SELECT
  pp.id            AS process_plan_id,
  jp.job_id        AS job_id,
  pp.unit_id       AS unit_id,
  pp.job_process_id AS job_process_id,
  COALESCE(jp.duration_max_days, 1) AS weight,
  CASE
    WHEN mapped.total > 0 THEN (mapped.complete::numeric / mapped.total) * 100
    WHEN pp.status = 'COMPLETE' THEN 100
    ELSE 0
  END AS percent
FROM process_plans pp
JOIN schedule_runs sr ON sr.id = pp.schedule_run_id AND sr.is_current = true
JOIN job_processes jp ON jp.id = pp.job_process_id
JOIN jobs j ON j.id = jp.job_id AND j.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
CROSS JOIN LATERAL (
  SELECT CASE WHEN pp.unit_id IS NOT NULL AND jp.code ~ '^[0-9]+$' THEN jp.code::int END AS lt_seq
) seq
CROSS JOIN LATERAL (
  SELECT
    COALESCE((
      SELECT count(*)
      FROM component_operations co
      JOIN components c ON c.id = co.component_id
      JOIN operation_ref_family_seqs orfs ON orfs.operation_ref_id = co.operation_id AND orfs.family_id = j.family_id
      WHERE c.unit_id = pp.unit_id AND orfs.lead_time_process_seq = seq.lt_seq
        AND co.retired_at IS NULL AND c.retired_at IS NULL
    ), 0)
    + COALESCE((
      SELECT count(*)
      FROM assembly_steps asm
      JOIN assembly_template_steps ats ON ats.id = asm.template_step_id
      WHERE asm.unit_id = pp.unit_id AND ats.lead_time_process_seq = seq.lt_seq
        AND asm.retired_at IS NULL
    ), 0) AS total,
    COALESCE((
      SELECT count(*)
      FROM component_operations co
      JOIN components c ON c.id = co.component_id
      JOIN operation_ref_family_seqs orfs ON orfs.operation_ref_id = co.operation_id AND orfs.family_id = j.family_id
      WHERE c.unit_id = pp.unit_id AND orfs.lead_time_process_seq = seq.lt_seq AND co.status = 'COMPLETE'
        AND co.retired_at IS NULL AND c.retired_at IS NULL
    ), 0)
    + COALESCE((
      SELECT count(*)
      FROM assembly_steps asm
      JOIN assembly_template_steps ats ON ats.id = asm.template_step_id
      WHERE asm.unit_id = pp.unit_id AND ats.lead_time_process_seq = seq.lt_seq AND asm.status = 'COMPLETE'
        AND asm.retired_at IS NULL
    ), 0) AS complete
) mapped;
