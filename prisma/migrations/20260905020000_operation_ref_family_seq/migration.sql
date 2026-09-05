-- Gate 3 prerequisite (v4 PROMPTS §5): OperationRef.leadTimeProcessSeq was
-- one tenant-wide number per canonical operation, authored only for
-- PRESSURE_VESSEL's 36-process spine. A second family's JobProcess.code
-- numbering would silently match through it (bare-value join, no FK).
-- Replaces it with a family-scoped mapping table: a family with no row here
-- fails open (SEAM) instead of borrowing another family's number.

-- CreateTable
CREATE TABLE "operation_ref_family_seqs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "operation_ref_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "lead_time_process_seq" INTEGER NOT NULL,

    CONSTRAINT "operation_ref_family_seqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operation_ref_family_seqs_tenant_id_idx" ON "operation_ref_family_seqs"("tenant_id");

-- CreateIndex
CREATE INDEX "operation_ref_family_seqs_family_id_lead_time_process_seq_idx" ON "operation_ref_family_seqs"("family_id", "lead_time_process_seq");

-- CreateIndex
CREATE UNIQUE INDEX "operation_ref_family_seqs_operation_ref_id_family_id_key" ON "operation_ref_family_seqs"("operation_ref_id", "family_id");

-- AddForeignKey
ALTER TABLE "operation_ref_family_seqs" ADD CONSTRAINT "operation_ref_family_seqs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_ref_family_seqs" ADD CONSTRAINT "operation_ref_family_seqs_operation_ref_id_fkey" FOREIGN KEY ("operation_ref_id") REFERENCES "operation_refs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_ref_family_seqs" ADD CONSTRAINT "operation_ref_family_seqs_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant RLS on the new tenant-root table (see rls-coverage.test.ts).
ALTER TABLE "operation_ref_family_seqs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "operation_ref_family_seqs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);

-- Backfill: every existing OperationRef.leadTimeProcessSeq value was
-- authored for PRESSURE_VESSEL (the only family with real Components today
-- — every RouteTemplate row in production is still family-agnostic,
-- confirmed before writing this migration). Behavior-preserving for the
-- family that actually uses this path; every other family now correctly
-- has no mapping instead of silently inheriting PRESSURE_VESSEL's numbers.
INSERT INTO "operation_ref_family_seqs" ("tenant_id", "operation_ref_id", "family_id", "lead_time_process_seq")
SELECT "or"."tenant_id", "or"."id", pf."id", "or"."lead_time_process_seq"
FROM "operation_refs" "or"
JOIN "product_families" pf
  ON pf."tenant_id" = "or"."tenant_id" AND pf."code" = 'PRESSURE_VESSEL'
WHERE "or"."lead_time_process_seq" IS NOT NULL;

-- v_process_plan_percent (20260827040000) also reads
-- operation_refs.lead_time_process_seq directly, with the identical
-- cross-family bug this migration is fixing — must be dropped before the
-- column can go, and recreated joined through the new family-scoped table.
DROP VIEW "v_process_plan_percent";

-- DropIndex
DROP INDEX "operation_refs_lead_time_process_seq_idx";

-- AlterTable
ALTER TABLE "operation_refs" DROP COLUMN "lead_time_process_seq";

-- Recreate v_process_plan_percent (see 20260827040000 for the ponytail note
-- on subquery-per-row at pilot scale — unchanged). Only the two
-- component-operation subqueries change: joined through
-- operation_ref_family_seqs and scoped to this job's own family_id, instead
-- of the bare operation_refs.lead_time_process_seq value. The
-- assembly-step subqueries are untouched — AssemblyTemplateStep is already
-- family-scoped via its own template/version chain.
CREATE VIEW v_process_plan_percent
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
JOIN jobs j ON j.id = jp.job_id
CROSS JOIN LATERAL (
  SELECT CASE WHEN pp.unit_id IS NOT NULL AND jp.code ~ '^[0-9]+$' THEN jp.code::int END AS lt_seq
) seq
CROSS JOIN LATERAL (
  SELECT
    COALESCE((
      SELECT count(*) FROM component_operations co
      JOIN components c ON c.id = co.component_id
      JOIN operation_ref_family_seqs orfs ON orfs.operation_ref_id = co.operation_id AND orfs.family_id = j.family_id
      WHERE c.unit_id = pp.unit_id AND orfs.lead_time_process_seq = seq.lt_seq
    ), 0)
    + COALESCE((
      SELECT count(*) FROM assembly_steps asm
      JOIN assembly_template_steps ats ON ats.id = asm.template_step_id
      WHERE asm.unit_id = pp.unit_id AND ats.lead_time_process_seq = seq.lt_seq
    ), 0) AS total,
    COALESCE((
      SELECT count(*) FROM component_operations co
      JOIN components c ON c.id = co.component_id
      JOIN operation_ref_family_seqs orfs ON orfs.operation_ref_id = co.operation_id AND orfs.family_id = j.family_id
      WHERE c.unit_id = pp.unit_id AND orfs.lead_time_process_seq = seq.lt_seq AND co.status = 'COMPLETE'
    ), 0)
    + COALESCE((
      SELECT count(*) FROM assembly_steps asm
      JOIN assembly_template_steps ats ON ats.id = asm.template_step_id
      WHERE asm.unit_id = pp.unit_id AND ats.lead_time_process_seq = seq.lt_seq AND asm.status = 'COMPLETE'
    ), 0) AS complete
) mapped;

GRANT SELECT ON v_process_plan_percent TO despl_web;
