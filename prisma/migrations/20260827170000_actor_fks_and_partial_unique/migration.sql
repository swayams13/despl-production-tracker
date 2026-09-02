-- Add missing actor FK constraints (B10, Phase 4)

-- ScheduleRun.createdBy
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ProcessPlan.submittedBy and verifiedBy
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ComponentOperation.submittedBy and verifiedBy
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ComponentOperationRejection.rejectedBy
ALTER TABLE "component_operation_rejections" ADD CONSTRAINT "component_operation_rejections_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- WeldJoint.loggedBy
ALTER TABLE "weld_joints" ADD CONSTRAINT "weld_joints_logged_by_fkey" FOREIGN KEY ("logged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- WeldLog.loggedBy
ALTER TABLE "weld_logs" ADD CONSTRAINT "weld_logs_logged_by_fkey" FOREIGN KEY ("logged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AssemblyStep.submittedBy and verifiedBy
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AssemblyStepRejection.rejectedBy
ALTER TABLE "assembly_step_rejections" ADD CONSTRAINT "assembly_step_rejections_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- QcpExecution.clearedBy and waiverApprovedBy
ALTER TABLE "qcp_executions" ADD CONSTRAINT "qcp_executions_cleared_by_fkey" FOREIGN KEY ("cleared_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "qcp_executions" ADD CONSTRAINT "qcp_executions_waiver_approved_by_fkey" FOREIGN KEY ("waiver_approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DelayReason.filedBy and reviewedBy
ALTER TABLE "delay_reasons" ADD CONSTRAINT "delay_reasons_filed_by_fkey" FOREIGN KEY ("filed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delay_reasons" ADD CONSTRAINT "delay_reasons_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ProgressSnapshot.publishedBy and verifiedBy
ALTER TABLE "progress_snapshots" ADD CONSTRAINT "progress_snapshots_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "progress_snapshots" ADD CONSTRAINT "progress_snapshots_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- BomRevision.createdBy
ALTER TABLE "bom_revisions" ADD CONSTRAINT "bom_revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NdtResult.recordedBy
ALTER TABLE "ndt_results" ADD CONSTRAINT "ndt_results_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ProcessTemplateVersion.publishedBy
ALTER TABLE "process_template_versions" ADD CONSTRAINT "process_template_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fix ProcessPlan unique constraint to handle null unitId case.
-- PostgreSQL treats NULL as distinct in a regular unique constraint,
-- allowing multiple (scheduleRunId, jobProcessId, NULL) rows to exist.
-- Keep the regular @@unique for non-null cases and add a partial unique
-- index for the null case (where unit_id IS NULL).
DROP INDEX IF EXISTS "process_plans_schedule_run_id_job_process_id_unit_id_key";
CREATE UNIQUE INDEX "process_plans_schedule_run_id_job_process_id_unit_id_key"
  ON "process_plans"("schedule_run_id", "job_process_id", "unit_id")
  WHERE "unit_id" IS NOT NULL;
CREATE UNIQUE INDEX "process_plans_schedule_run_id_job_process_id_partial_unique"
  ON "process_plans"("schedule_run_id", "job_process_id")
  WHERE "unit_id" IS NULL;
