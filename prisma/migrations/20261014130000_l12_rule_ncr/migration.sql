-- Lean Core L1.2f — rule NCRs for D2 H5/H6 (welding after final PWHT / after
-- hydro). A rule NCR has no rejection behind it: it names the refused item
-- (an assembly step or a component operation) and the rule. Additive; every
-- existing row keeps its one rejection source.
--
--   * NcrRuleCode enum             H5 | H6
--   * ncrs.target_assembly_step_id / target_component_operation_id
--   * ncrs.rule_code, raised_by, raised_at (all set on a rule NCR, all null otherwise)
--   * ncrs.code_clause, concession_approved_by_id ("accept per code exception",
--     Production Head per decision 1 of 14 Oct, clause mandatory)
--   * ncr_exactly_one_source: exactly one of the two rejection ids and the two
--     targets (replaces the two-way CHECK of 20260831064422; that migration is
--     applied and stays untouched)
--
-- RLS on ncrs is unchanged (job_isolation + tenant_isolation; tenant_id still
-- derived from job_id by the aud001 trigger). No grant changes.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "NcrRuleCode" AS ENUM ('H5', 'H6');

ALTER TABLE "ncrs"
  ADD COLUMN "target_assembly_step_id" INTEGER,
  ADD COLUMN "target_component_operation_id" INTEGER,
  ADD COLUMN "rule_code" "NcrRuleCode",
  ADD COLUMN "code_clause" TEXT,
  ADD COLUMN "concession_approved_by_id" INTEGER,
  ADD COLUMN "raised_by" INTEGER,
  ADD COLUMN "raised_at" TIMESTAMP(3);

ALTER TABLE "ncrs" DROP CONSTRAINT "ncr_exactly_one_source";
ALTER TABLE "ncrs" ADD CONSTRAINT "ncr_exactly_one_source" CHECK (
  (component_operation_rejection_id IS NOT NULL)::int +
  (assembly_step_rejection_id IS NOT NULL)::int +
  (target_assembly_step_id IS NOT NULL)::int +
  (target_component_operation_id IS NOT NULL)::int = 1
);

-- A target comes with its rule and who raised it when; nothing else carries them.
ALTER TABLE "ncrs" ADD CONSTRAINT "ncr_rule_fields_chk" CHECK (
  ((target_assembly_step_id IS NOT NULL OR target_component_operation_id IS NOT NULL)
    AND rule_code IS NOT NULL AND raised_by IS NOT NULL AND raised_at IS NOT NULL)
  OR
  (target_assembly_step_id IS NULL AND target_component_operation_id IS NULL
    AND rule_code IS NULL AND raised_by IS NULL AND raised_at IS NULL)
);

-- A recorded concession approval always carries its code clause.
ALTER TABLE "ncrs" ADD CONSTRAINT "ncr_concession_clause_chk" CHECK (
  concession_approved_by_id IS NULL OR code_clause IS NOT NULL
);

CREATE INDEX "ncrs_target_assembly_step_id_idx" ON "ncrs"("target_assembly_step_id");
CREATE INDEX "ncrs_target_component_operation_id_idx" ON "ncrs"("target_component_operation_id");
CREATE INDEX "ncrs_raised_by_idx" ON "ncrs"("raised_by");
CREATE INDEX "ncrs_concession_approved_by_id_idx" ON "ncrs"("concession_approved_by_id");

ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_target_assembly_step_id_fkey"
  FOREIGN KEY ("target_assembly_step_id") REFERENCES "assembly_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_target_component_operation_id_fkey"
  FOREIGN KEY ("target_component_operation_id") REFERENCES "component_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_raised_by_fkey"
  FOREIGN KEY ("raised_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_concession_approved_by_id_fkey"
  FOREIGN KEY ("concession_approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
