-- AUD-080 — step 3 of 5: backfill, preflight, NOT NULL + FK.
--
-- Same direct, one-hop join as AUD-001 (20260909110000): all nine tables
-- carry job_id directly, backed by a FK to jobs(id) — RESTRICT for the eight
-- strict tables (Prisma default when no onDelete is given on a required
-- relation scalar; confirmed live against despl_test's actual FK definitions
-- before writing this), SET NULL for qcp_templates (Prisma default for an
-- optional relation scalar — confirmed against the init migration's
-- qcp_templates_job_id_fkey). Either way job_id, wherever non-null, is
-- guaranteed to reference a real jobs row, so the backfill join can't land
-- on a nonexistent job.
--
--   UPDATE <table> t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id
--
-- PREFLIGHT: after the backfill, any row with tenant_id IS NULL on one of
-- the eight NOT-NULL-bound tables would mean job_id was NULL (impossible,
-- job_id is NOT NULL on all eight) or job_id pointed at a nonexistent job
-- (impossible under the FK above) — RAISE EXCEPTION with table name and
-- count rather than let a silent NOT NULL failure surface further down.
-- qcp_templates is NOT in the preflight/NOT-NULL list — job_id IS NULL by
-- design for library rows (mirrors qcp_items/inspection_parties/
-- qcp_item_party_codes in the AUD-001 batch), and those rows are expected to
-- keep tenant_id IS NULL after this backfill.

UPDATE "equipments" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "packages" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "job_processes" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "schedule_runs" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "weld_joints" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "weld_logs" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "assembly_drawings" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "dispatch_batches" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;
UPDATE "qcp_templates" t SET tenant_id = j.tenant_id FROM jobs j WHERE j.id = t.job_id AND t.tenant_id IS NULL;

DO $$
DECLARE
  t text;
  orphan_count bigint;
  not_null_tables text[] := ARRAY[
    'equipments', 'packages', 'job_processes', 'schedule_runs',
    'weld_joints', 'weld_logs', 'assembly_drawings', 'dispatch_batches'
  ];
BEGIN
  FOREACH t IN ARRAY not_null_tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id IS NULL', t) INTO orphan_count;
    IF orphan_count > 0 THEN
      RAISE EXCEPTION 'AUD-080 preflight failed: % has % row(s) with tenant_id IS NULL after backfill', t, orphan_count;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE "equipments" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "equipments" ADD CONSTRAINT "equipments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "packages" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "packages" ADD CONSTRAINT "packages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "job_processes" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "schedule_runs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "weld_joints" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "weld_joints" ADD CONSTRAINT "weld_joints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "weld_logs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "weld_logs" ADD CONSTRAINT "weld_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "assembly_drawings" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "assembly_drawings" ADD CONSTRAINT "assembly_drawings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "dispatch_batches" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- qcp_templates stays nullable — library rows (job_id IS NULL) genuinely
-- have no tenant either. FK still added so any row that DOES have a
-- tenant_id stays honest.
ALTER TABLE "qcp_templates" ADD CONSTRAINT "qcp_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
