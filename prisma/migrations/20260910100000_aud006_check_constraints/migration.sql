-- AUD-006: recommended CHECK constraint set, items 1-7 of `11_DATABASE_AUDIT.md` §10.
-- Excludes item 6 (qcp_executions — incompatible with AUD-003's shipped two-step
-- waiver design), item 8 (schedule_runs — already shipped in a stronger form by
-- AUD-034), and item 9 (units serial-number uniqueness — AUD-099, gated on a
-- business-rule decision, separate session).
--
-- Every constraint added NOT VALID first, then VALIDATED separately, so a deploy
-- against a live table never holds a long ACCESS EXCLUSIVE lock while scanning
-- existing rows (same reasoning as `11_DATABASE_AUDIT.md` §9's migration-lock
-- finding). Preflight data-audit queries (documented in the PR) returned zero
-- violating rows on a freshly-seeded database built from exactly this migration
-- set, for every one of the six groups below.

-- 1. actual_finish must not precede actual_start.
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_finish_after_start"
  CHECK (actual_finish IS NULL OR actual_start IS NULL OR actual_finish >= actual_start)
  NOT VALID;
ALTER TABLE "process_plans" VALIDATE CONSTRAINT "process_plans_finish_after_start";

ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_finish_after_start"
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
  NOT VALID;
ALTER TABLE "component_operations" VALIDATE CONSTRAINT "component_operations_finish_after_start";

ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_finish_after_start"
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
  NOT VALID;
ALTER TABLE "assembly_steps" VALIDATE CONSTRAINT "assembly_steps_finish_after_start";

-- 2. published completion percentage must be a real percentage.
ALTER TABLE "progress_snapshots" ADD CONSTRAINT "progress_snapshots_pct_in_range"
  CHECK (overall_pct BETWEEN 0 AND 100)
  NOT VALID;
ALTER TABLE "progress_snapshots" VALIDATE CONSTRAINT "progress_snapshots_pct_in_range";

-- 3. process durations must be positive, and the max/min envelope must be ordered.
ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_duration_min_positive"
  CHECK (duration_min_days IS NULL OR duration_min_days > 0)
  NOT VALID;
ALTER TABLE "job_processes" VALIDATE CONSTRAINT "job_processes_duration_min_positive";

ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_duration_max_at_least_min"
  CHECK (duration_max_days IS NULL OR duration_max_days >= duration_min_days)
  NOT VALID;
ALTER TABLE "job_processes" VALIDATE CONSTRAINT "job_processes_duration_max_at_least_min";

ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_duration_override_positive"
  CHECK (duration_override_days IS NULL OR duration_override_days > 0)
  NOT VALID;
ALTER TABLE "job_processes" VALIDATE CONSTRAINT "job_processes_duration_override_positive";

ALTER TABLE "template_processes" ADD CONSTRAINT "template_processes_duration_min_positive"
  CHECK (duration_min_days IS NULL OR duration_min_days > 0)
  NOT VALID;
ALTER TABLE "template_processes" VALIDATE CONSTRAINT "template_processes_duration_min_positive";

ALTER TABLE "template_processes" ADD CONSTRAINT "template_processes_duration_max_at_least_min"
  CHECK (duration_max_days IS NULL OR duration_max_days >= duration_min_days)
  NOT VALID;
ALTER TABLE "template_processes" VALIDATE CONSTRAINT "template_processes_duration_max_at_least_min";

-- 4. stock movements/lots cannot be driven negative. Direction belongs to `type`,
-- not the sign, on stock_txns; a lot's on-hand qty can never be negative.
ALTER TABLE "stock_txns" ADD CONSTRAINT "stock_txns_qty_positive"
  CHECK (qty > 0)
  NOT VALID;
ALTER TABLE "stock_txns" VALIDATE CONSTRAINT "stock_txns_qty_positive";

ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_qty_non_negative"
  CHECK (qty >= 0)
  NOT VALID;
ALTER TABLE "stock_lots" VALIDATE CONSTRAINT "stock_lots_qty_non_negative";

-- 5. component-operation quantities cannot be negative, and good+rejected can
-- never exceed planned.
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_qty_non_negative"
  CHECK ("qtyGood" >= 0 AND "qtyRejected" >= 0)
  NOT VALID;
ALTER TABLE "component_operations" VALIDATE CONSTRAINT "component_operations_qty_non_negative";

ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_qty_sum_within_planned"
  CHECK ("qtyPlanned" IS NULL OR "qtyGood" + "qtyRejected" <= "qtyPlanned")
  NOT VALID;
ALTER TABLE "component_operations" VALIDATE CONSTRAINT "component_operations_qty_sum_within_planned";

-- 7. status-evidence pairs: a status claiming a completion event must carry
-- that event's evidence columns.
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_complete_has_finish"
  CHECK (status <> 'COMPLETE' OR actual_finish IS NOT NULL)
  NOT VALID;
ALTER TABLE "process_plans" VALIDATE CONSTRAINT "process_plans_complete_has_finish";

ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_closed_has_closer_and_timestamp"
  CHECK (status <> 'CLOSED' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL))
  NOT VALID;
ALTER TABLE "ncrs" VALIDATE CONSTRAINT "ncrs_closed_has_closer_and_timestamp";
