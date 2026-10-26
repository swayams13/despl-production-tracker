-- D2: Production Head acknowledgement of out-of-sequence (SOFT) starts.
-- New append-only table; sequence_overrides itself stays untouched. One row per
-- override at most (unique override_id). Same RLS and grants as work_requests.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "sequence_override_acks" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL DEFAULT 0,
    "job_id" INTEGER NOT NULL,
    "override_id" INTEGER NOT NULL,
    "acknowledged_by" INTEGER NOT NULL,
    "acknowledged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sequence_override_acks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sequence_override_acks_override_id_key" ON "sequence_override_acks"("override_id");
CREATE INDEX "sequence_override_acks_job_id_idx" ON "sequence_override_acks"("job_id");
CREATE INDEX "sequence_override_acks_tenant_id_idx" ON "sequence_override_acks"("tenant_id");

ALTER TABLE "sequence_override_acks" ADD CONSTRAINT "sequence_override_acks_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_override_acks" ADD CONSTRAINT "sequence_override_acks_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_override_acks" ADD CONSTRAINT "sequence_override_acks_override_id_fkey"
  FOREIGN KEY ("override_id") REFERENCES "sequence_overrides"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_override_acks" ADD CONSTRAINT "sequence_override_acks_acknowledged_by_fkey"
  FOREIGN KEY ("acknowledged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER aud001_tenant_id_autofill BEFORE INSERT ON "sequence_override_acks"
  FOR EACH ROW EXECUTE FUNCTION aud001_derive_tenant_id();

ALTER TABLE "sequence_override_acks" ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_isolation ON "sequence_override_acks"
  USING (
    job_id IS NULL
    OR NULLIF(current_setting('app.job_id', true), '') IS NULL
    OR job_id = NULLIF(current_setting('app.job_id', true), '')::int
  )
  WITH CHECK (
    job_id IS NULL
    OR NULLIF(current_setting('app.job_id', true), '') IS NULL
    OR job_id = NULLIF(current_setting('app.job_id', true), '')::int
  );

CREATE POLICY tenant_isolation ON "sequence_override_acks" AS RESTRICTIVE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);

GRANT SELECT, INSERT ON "sequence_override_acks" TO despl_app;
GRANT USAGE, SELECT ON SEQUENCE "sequence_override_acks_id_seq" TO despl_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "sequence_override_acks" FROM despl_app;
