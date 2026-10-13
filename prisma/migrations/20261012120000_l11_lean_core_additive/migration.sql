-- Lean Core L1.1 — additive migration. No behaviour change: every new column
-- defaults to today's behaviour, and nothing reads them until L1.2+.
--
--   * grain (JOB | UNIT)            template_processes, job_processes
--   * enforcement (HARD | SOFT)     template_edges, job_process_edges
--   * requires_qc (default true)    operation_refs, assembly_template_steps,
--                                   template_processes, job_processes,
--                                   component_operations, assembly_steps
--   * reported_start_at / _finish_at (nullable)
--                                   process_plans, component_operations,
--                                   assembly_steps
--   * sequence_overrides            new append-only table (RLS like siblings)
--   * units.public_id               unique opaque id for QR URLs, backfilled
--   * users.locale                  en | hi | gu
--   * roles OPERATOR, PLANNER, STORES, ENGINEERING inserted for every org
--
-- Every ADD COLUMN uses a constant default (metadata-only in Postgres 11+, no
-- table rewrite) except units.public_id, whose volatile default rewrites the
-- `units` table once (10 rows in production). The old container keeps working
-- during the pre-deploy window because every new column has a default.
--
-- Grants: despl_web gets its rights by membership in despl_app, so the
-- append-only revoke is on despl_app (same as 20260827180000). Naming
-- despl_web here would break a from-scratch replay (it does not exist yet).

SET LOCAL lock_timeout = '5s';

-- ── Enums ───────────────────────────────────────────────────────────────
CREATE TYPE "ProcessGrain" AS ENUM ('JOB', 'UNIT');
CREATE TYPE "EdgeEnforcement" AS ENUM ('HARD', 'SOFT');
CREATE TYPE "Locale" AS ENUM ('en', 'hi', 'gu');
CREATE TYPE "SequenceOverrideTargetKind" AS ENUM ('PROCESS_PLAN', 'COMPONENT_OP', 'ASSEMBLY_STEP');

-- ── Columns ─────────────────────────────────────────────────────────────
ALTER TABLE "template_processes"
  ADD COLUMN "grain" "ProcessGrain" NOT NULL DEFAULT 'UNIT',
  ADD COLUMN "requires_qc" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "job_processes"
  ADD COLUMN "grain" "ProcessGrain" NOT NULL DEFAULT 'UNIT',
  ADD COLUMN "requires_qc" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "template_edges"
  ADD COLUMN "enforcement" "EdgeEnforcement" NOT NULL DEFAULT 'HARD';

ALTER TABLE "job_process_edges"
  ADD COLUMN "enforcement" "EdgeEnforcement" NOT NULL DEFAULT 'HARD';

ALTER TABLE "operation_refs"
  ADD COLUMN "requires_qc" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "assembly_template_steps"
  ADD COLUMN "requires_qc" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "process_plans"
  ADD COLUMN "reported_start_at" TIMESTAMP(3),
  ADD COLUMN "reported_finish_at" TIMESTAMP(3);

ALTER TABLE "component_operations"
  ADD COLUMN "reported_start_at" TIMESTAMP(3),
  ADD COLUMN "reported_finish_at" TIMESTAMP(3),
  ADD COLUMN "requires_qc" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "assembly_steps"
  ADD COLUMN "reported_start_at" TIMESTAMP(3),
  ADD COLUMN "reported_finish_at" TIMESTAMP(3),
  ADD COLUMN "requires_qc" BOOLEAN NOT NULL DEFAULT true;

-- A reported finish can never precede a reported start (CHECK, like AUD-006).
-- Either side may be null: START and DONE are reported separately.
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_reported_order_chk"
  CHECK ("reported_start_at" IS NULL OR "reported_finish_at" IS NULL OR "reported_finish_at" >= "reported_start_at");
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_reported_order_chk"
  CHECK ("reported_start_at" IS NULL OR "reported_finish_at" IS NULL OR "reported_finish_at" >= "reported_start_at");
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_reported_order_chk"
  CHECK ("reported_start_at" IS NULL OR "reported_finish_at" IS NULL OR "reported_finish_at" >= "reported_start_at");

ALTER TABLE "users" ADD COLUMN "locale" "Locale" NOT NULL DEFAULT 'en';

-- Opaque QR id. The volatile default gives every existing row its own value in
-- this same statement; new rows from any insert path get one from the column
-- default (Job.publicId is generated in app code, Unit's is not).
ALTER TABLE "units" ADD COLUMN "public_id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text;
CREATE UNIQUE INDEX "units_public_id_key" ON "units"("public_id");

-- ── sequence_overrides (append-only) ────────────────────────────────────
CREATE TABLE "sequence_overrides" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "tenant_id" INTEGER NOT NULL DEFAULT 0,
    "target_kind" "SequenceOverrideTargetKind" NOT NULL,
    "target_id" INTEGER NOT NULL,
    "unit_id" INTEGER,
    "edge_id" INTEGER,
    "category" TEXT NOT NULL,
    "note" TEXT,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sequence_overrides_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sequence_overrides_job_id_idx" ON "sequence_overrides"("job_id");
CREATE INDEX "sequence_overrides_tenant_id_idx" ON "sequence_overrides"("tenant_id");
CREATE INDEX "sequence_overrides_target_kind_target_id_idx" ON "sequence_overrides"("target_kind", "target_id");
CREATE INDEX "sequence_overrides_tenant_id_created_at_idx" ON "sequence_overrides"("tenant_id", "created_at");

ALTER TABLE "sequence_overrides" ADD CONSTRAINT "sequence_overrides_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_overrides" ADD CONSTRAINT "sequence_overrides_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_overrides" ADD CONSTRAINT "sequence_overrides_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_overrides" ADD CONSTRAINT "sequence_overrides_edge_id_fkey"
  FOREIGN KEY ("edge_id") REFERENCES "job_process_edges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_overrides" ADD CONSTRAINT "sequence_overrides_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- tenant_id is derived from job_id on insert (AUD-001), exactly as for the 28
-- sibling job-grain tables; the app never has to set it.
CREATE TRIGGER aud001_tenant_id_autofill BEFORE INSERT ON "sequence_overrides"
  FOR EACH ROW EXECUTE FUNCTION aud001_derive_tenant_id();

-- Row-level security: the same two policies as procurement_events
-- (20260905090000 / 20260905091500 job_isolation, 20260909120000 tenant_isolation).
ALTER TABLE "sequence_overrides" ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_isolation ON "sequence_overrides"
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

CREATE POLICY tenant_isolation ON "sequence_overrides" AS RESTRICTIVE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);

-- Append-only: SELECT + INSERT only. Default privileges would grant the full
-- CRUD set to despl_app; take UPDATE/DELETE (and TRUNCATE) back.
GRANT SELECT, INSERT ON "sequence_overrides" TO despl_app;
GRANT USAGE, SELECT ON SEQUENCE "sequence_overrides_id_seq" TO despl_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "sequence_overrides" FROM despl_app;

-- ── Roles ───────────────────────────────────────────────────────────────
-- Roles are rows, not an enum, and prisma/seed.ts returns early when the org
-- already exists, so production and staging only get the new roles from here.
-- A fresh database (no organizations yet) inserts nothing; the seed adds them.
INSERT INTO "roles" ("tenant_id", "code", "name")
SELECT o."id", v."code", v."name"
FROM "organizations" o
CROSS JOIN (VALUES
  ('OPERATOR', 'Floor Operator'),
  ('PLANNER', 'Planner / PPC'),
  ('STORES', 'Stores'),
  ('ENGINEERING', 'Engineering')
) AS v("code", "name")
ON CONFLICT ("tenant_id", "code") DO NOTHING;
