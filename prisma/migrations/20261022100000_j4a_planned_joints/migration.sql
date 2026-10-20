-- Lean Core J4a: planned joints and scoped assembly steps.
-- Additive and forward-only. Every existing template step stays PER_UNIT and every
-- existing step row keeps its own seq, so existing jobs are untouched.

CREATE TYPE "AssemblyStepScope" AS ENUM ('PER_UNIT', 'PER_JOINT', 'PER_COMPONENT');
CREATE TYPE "JointType" AS ENUM ('LONG_SEAM', 'CIRC_SEAM', 'NOZZLE', 'ATTACHMENT');
CREATE TYPE "PlannedJointSource" AS ENUM ('IMPORTED', 'GENERATED');

-- ── scope on the template step ───────────────────────────────────────────────
ALTER TABLE "assembly_template_steps" ADD COLUMN "scope" "AssemblyStepScope" NOT NULL DEFAULT 'PER_UNIT';
ALTER TABLE "assembly_template_steps" ADD COLUMN "joint_type" "JointType";
ALTER TABLE "assembly_template_steps" ADD COLUMN "component_type_id" INTEGER;

ALTER TABLE "assembly_template_steps"
  ADD CONSTRAINT "assembly_template_steps_component_type_id_fkey"
  FOREIGN KEY ("component_type_id") REFERENCES "component_type_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "assembly_template_steps_component_type_id_idx" ON "assembly_template_steps"("component_type_id");

-- A scope carries exactly its own selector; a literal joint_ref is only for PER_UNIT steps.
ALTER TABLE "assembly_template_steps" ADD CONSTRAINT "assembly_template_steps_scope_chk" CHECK (
  ("scope" = 'PER_UNIT'      AND "joint_type" IS NULL     AND "component_type_id" IS NULL)
  OR ("scope" = 'PER_JOINT'     AND "joint_type" IS NOT NULL AND "component_type_id" IS NULL AND "joint_ref" IS NULL)
  OR ("scope" = 'PER_COMPONENT' AND "joint_type" IS NULL     AND "component_type_id" IS NOT NULL)
);

-- ── planned_joints (job-grain) ───────────────────────────────────────────────
CREATE TABLE "planned_joints" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "tenant_id" INTEGER NOT NULL DEFAULT 0,
    "equipment_id" INTEGER NOT NULL,
    "joint_no" TEXT NOT NULL,
    "joint_type" "JointType" NOT NULL,
    "joins" TEXT,
    "wps_ref" TEXT,
    "ndt_extent" TEXT,
    "source" "PlannedJointSource" NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planned_joints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "planned_joints_equipment_id_joint_no_key" ON "planned_joints"("equipment_id", "joint_no");
CREATE INDEX "planned_joints_job_id_idx" ON "planned_joints"("job_id");
CREATE INDEX "planned_joints_tenant_id_idx" ON "planned_joints"("tenant_id");

ALTER TABLE "planned_joints" ADD CONSTRAINT "planned_joints_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "planned_joints" ADD CONSTRAINT "planned_joints_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "planned_joints" ADD CONSTRAINT "planned_joints_equipment_id_fkey"
  FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "planned_joints" ADD CONSTRAINT "planned_joints_joint_no_chk" CHECK (btrim("joint_no") <> '' AND "joint_no" = btrim("joint_no"));

-- The line must belong to the job (no composite FK without a unique on equipments(id, job_id)).
CREATE FUNCTION "planned_joints_line_same_job"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "equipments" WHERE "id" = NEW."equipment_id" AND "job_id" = NEW."job_id") THEN
    RAISE EXCEPTION 'planned_joints.equipment_id % does not belong to job %', NEW."equipment_id", NEW."job_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "planned_joints_line_same_job_trg"
  BEFORE INSERT OR UPDATE OF "equipment_id", "job_id" ON "planned_joints"
  FOR EACH ROW EXECUTE FUNCTION "planned_joints_line_same_job"();

-- tenant_id is derived from job_id on insert (AUD-001), like the sibling job-grain tables.
CREATE TRIGGER aud001_tenant_id_autofill BEFORE INSERT ON "planned_joints"
  FOR EACH ROW EXECUTE FUNCTION aud001_derive_tenant_id();

ALTER TABLE "planned_joints" ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_isolation ON "planned_joints"
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

CREATE POLICY tenant_isolation ON "planned_joints" AS RESTRICTIVE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);

-- ── links from the as-built side ─────────────────────────────────────────────
ALTER TABLE "assembly_steps" ADD COLUMN "planned_joint_id" INTEGER;
ALTER TABLE "assembly_steps" ADD COLUMN "component_id" INTEGER;
ALTER TABLE "weld_joints" ADD COLUMN "planned_joint_id" INTEGER;

ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_planned_joint_id_fkey"
  FOREIGN KEY ("planned_joint_id") REFERENCES "planned_joints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_component_id_fkey"
  FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "weld_joints" ADD CONSTRAINT "weld_joints_planned_joint_id_fkey"
  FOREIGN KEY ("planned_joint_id") REFERENCES "planned_joints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "assembly_steps_planned_joint_id_idx" ON "assembly_steps"("planned_joint_id");
CREATE INDEX "assembly_steps_component_id_idx" ON "assembly_steps"("component_id");
CREATE INDEX "weld_joints_planned_joint_id_idx" ON "weld_joints"("planned_joint_id");
