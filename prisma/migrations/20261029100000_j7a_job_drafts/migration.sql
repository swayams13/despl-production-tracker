-- Lean Core J7a (Q1): job drafts. A draft is NOT a Job row or a JobStatus value (a DRAFT job status
-- would leak into every reader that filters status). One new tenant-root table, no change to any
-- existing table. Discard is a status: no DELETE and no TRUNCATE grant.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "JobDraftStatus" AS ENUM ('DRAFT', 'RELEASED', 'DISCARDED');

CREATE TABLE "job_drafts" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_job_id" INTEGER,
    "payload" JSONB NOT NULL,
    "status" "JobDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "released_job_id" INTEGER,

    CONSTRAINT "job_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_drafts_tenant_id_status_idx" ON "job_drafts"("tenant_id", "status");
CREATE INDEX "job_drafts_created_by_idx" ON "job_drafts"("created_by");

ALTER TABLE "job_drafts" ADD CONSTRAINT "job_drafts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_drafts" ADD CONSTRAINT "job_drafts_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_drafts" ADD CONSTRAINT "job_drafts_source_job_id_fkey"
  FOREIGN KEY ("source_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "job_drafts" ADD CONSTRAINT "job_drafts_released_job_id_fkey"
  FOREIGN KEY ("released_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Only a RELEASED draft names a job (a deleted job leaves it NULL).
ALTER TABLE "job_drafts" ADD CONSTRAINT "job_drafts_released_chk" CHECK ("status" = 'RELEASED' OR "released_job_id" IS NULL);

ALTER TABLE "job_drafts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "job_drafts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);

-- Default privileges would grant the full CRUD set; a draft is discarded by status, never deleted.
GRANT SELECT, INSERT, UPDATE ON "job_drafts" TO despl_app;
GRANT USAGE, SELECT ON SEQUENCE "job_drafts_id_seq" TO despl_app;
REVOKE DELETE, TRUNCATE ON "job_drafts" FROM despl_app;
