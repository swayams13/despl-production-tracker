-- Lean Core L1.2b — floor facts for recordWork's HARD rules (D2). Additive,
-- no backfill: every new column defaults to today's behaviour, and nothing
-- reads them until L1.2d.
--
--   * AssemblyStepRole enum         FIT_UP | WELD | NDT | HEAT_TREATMENT | FINAL_PWHT | HYDRO
--   * role, pressure_part           assembly_template_steps (template; v1 rows stay null/false)
--   * role, joint_ref, pressure_part
--                                   assembly_steps (job-level copies, set at intake)
--   * pressure_retaining            components, part_families (H2/H3 scope)
--   * at-risk release (4 columns)   drawing_revisions (H3; first three all-or-none)
--   * predecessor_target_id         sequence_overrides (the earlier item a SOFT override skipped)
--   * work_requests                 new append-only table: recordWork idempotency (requestId)
--
-- Every ADD COLUMN is nullable or has a constant default (metadata-only, no
-- table rewrite). Grants mirror 20261012120000 (sequence_overrides).

SET LOCAL lock_timeout = '5s';

-- ── Enum ────────────────────────────────────────────────────────────────
CREATE TYPE "AssemblyStepRole" AS ENUM ('FIT_UP', 'WELD', 'NDT', 'HEAT_TREATMENT', 'FINAL_PWHT', 'HYDRO');

-- ── Columns ─────────────────────────────────────────────────────────────
ALTER TABLE "assembly_template_steps"
  ADD COLUMN "role" "AssemblyStepRole",
  ADD COLUMN "pressure_part" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "assembly_steps"
  ADD COLUMN "role" "AssemblyStepRole",
  ADD COLUMN "joint_ref" TEXT,
  ADD COLUMN "pressure_part" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "components" ADD COLUMN "pressure_retaining" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "part_families" ADD COLUMN "pressure_retaining" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "drawing_revisions"
  ADD COLUMN "at_risk_released_by_id" INTEGER,
  ADD COLUMN "at_risk_released_at" TIMESTAMP(3),
  ADD COLUMN "at_risk_reason" TEXT,
  ADD COLUMN "client_consent_ref" TEXT;

ALTER TABLE "drawing_revisions" ADD CONSTRAINT "drawing_revisions_at_risk_release_chk"
  CHECK (
    ("at_risk_released_by_id" IS NULL AND "at_risk_released_at" IS NULL AND "at_risk_reason" IS NULL)
    OR ("at_risk_released_by_id" IS NOT NULL AND "at_risk_released_at" IS NOT NULL AND "at_risk_reason" IS NOT NULL)
  );

ALTER TABLE "drawing_revisions" ADD CONSTRAINT "drawing_revisions_at_risk_released_by_id_fkey"
  FOREIGN KEY ("at_risk_released_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "drawing_revisions_at_risk_released_by_id_idx" ON "drawing_revisions"("at_risk_released_by_id");

ALTER TABLE "sequence_overrides" ADD COLUMN "predecessor_target_id" INTEGER;

-- ── work_requests (append-only) ─────────────────────────────────────────
-- One row per recordWork requestId: a replay returns the stored response and
-- writes nothing.
CREATE TABLE "work_requests" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL DEFAULT 0,
    "job_id" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "actor_id" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_requests_tenant_id_request_id_key" ON "work_requests"("tenant_id", "request_id");
CREATE INDEX "work_requests_job_id_idx" ON "work_requests"("job_id");

ALTER TABLE "work_requests" ADD CONSTRAINT "work_requests_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_requests" ADD CONSTRAINT "work_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_requests" ADD CONSTRAINT "work_requests_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER aud001_tenant_id_autofill BEFORE INSERT ON "work_requests"
  FOR EACH ROW EXECUTE FUNCTION aud001_derive_tenant_id();

ALTER TABLE "work_requests" ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_isolation ON "work_requests"
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

CREATE POLICY tenant_isolation ON "work_requests" AS RESTRICTIVE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);

GRANT SELECT, INSERT ON "work_requests" TO despl_app;
GRANT USAGE, SELECT ON SEQUENCE "work_requests_id_seq" TO despl_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "work_requests" FROM despl_app;
