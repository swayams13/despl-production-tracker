-- Lean Core J2: questions and rules as data.
-- Additive and forward-only: new nullable columns, two new empty tables.
-- No existing row changes; a job with no rules behaves exactly as before.

CREATE TYPE "ConfigQuestionType" AS ENUM ('NUMBER', 'TEXT', 'SELECT', 'BOOLEAN');
CREATE TYPE "ConfigRuleEntity" AS ENUM ('TEMPLATE_PROCESS', 'ASSEMBLY_STEP', 'ROUTE_STEP', 'QCP_ITEM');

ALTER TABLE "equipments" ADD COLUMN "config" JSONB;
ALTER TABLE "template_processes" ADD COLUMN "include_when" JSONB;
ALTER TABLE "assembly_template_steps" ADD COLUMN "include_when" JSONB;
ALTER TABLE "qcp_items" ADD COLUMN "include_when" JSONB;
ALTER TABLE "job_processes" ADD COLUMN "inclusion_reason" JSONB;

-- ── config_questions (tenant-root) ──────────────────────────────────────
CREATE TABLE "config_questions" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "equipment_type_id" INTEGER,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "ConfigQuestionType" NOT NULL,
    "unit" TEXT,
    "options" JSONB,
    "default_value" JSONB,
    "help" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "config_questions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "config_questions_family_id_key_key" ON "config_questions"("family_id", "key");
CREATE INDEX "config_questions_tenant_id_idx" ON "config_questions"("tenant_id");
CREATE INDEX "config_questions_equipment_type_id_idx" ON "config_questions"("equipment_type_id");

ALTER TABLE "config_questions" ADD CONSTRAINT "config_questions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "config_questions" ADD CONSTRAINT "config_questions_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "config_questions" ADD CONSTRAINT "config_questions_equipment_type_id_fkey"
  FOREIGN KEY ("equipment_type_id") REFERENCES "equipment_type_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- snake_case so `ANSWER:<key>` quantities (J1) and includeWhen rules can name it
ALTER TABLE "config_questions" ADD CONSTRAINT "config_questions_key_chk"
  CHECK ("key" ~ '^[a-z][a-z0-9_]*$');
-- a SELECT needs a non-empty array of choices; any other type has none
ALTER TABLE "config_questions" ADD CONSTRAINT "config_questions_options_chk"
  CHECK (
    CASE WHEN "type" = 'SELECT'
      THEN CASE WHEN jsonb_typeof("options") = 'array' THEN jsonb_array_length("options") > 0 ELSE false END
      ELSE "options" IS NULL
    END
  );

ALTER TABLE "config_questions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "config_questions"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);

-- ── config_rule_decisions (job-grain, append-only) ──────────────────────
CREATE TABLE "config_rule_decisions" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "tenant_id" INTEGER NOT NULL DEFAULT 0,
    "equipment_id" INTEGER NOT NULL,
    "entity_type" "ConfigRuleEntity" NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "included" BOOLEAN NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "reason" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_rule_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "config_rule_decisions_job_id_idx" ON "config_rule_decisions"("job_id");
CREATE INDEX "config_rule_decisions_tenant_id_idx" ON "config_rule_decisions"("tenant_id");
CREATE INDEX "config_rule_decisions_equipment_id_idx" ON "config_rule_decisions"("equipment_id");

ALTER TABLE "config_rule_decisions" ADD CONSTRAINT "config_rule_decisions_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "config_rule_decisions" ADD CONSTRAINT "config_rule_decisions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "config_rule_decisions" ADD CONSTRAINT "config_rule_decisions_equipment_id_fkey"
  FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- tenant_id is derived from job_id on insert (AUD-001), like the sibling job-grain tables.
CREATE TRIGGER aud001_tenant_id_autofill BEFORE INSERT ON "config_rule_decisions"
  FOR EACH ROW EXECUTE FUNCTION aud001_derive_tenant_id();

ALTER TABLE "config_rule_decisions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_isolation ON "config_rule_decisions"
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

CREATE POLICY tenant_isolation ON "config_rule_decisions" AS RESTRICTIVE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);

-- Append-only: SELECT + INSERT only (default privileges would grant the full CRUD set).
GRANT SELECT, INSERT ON "config_rule_decisions" TO despl_app;
GRANT USAGE, SELECT ON SEQUENCE "config_rule_decisions_id_seq" TO despl_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "config_rule_decisions" FROM despl_app;
