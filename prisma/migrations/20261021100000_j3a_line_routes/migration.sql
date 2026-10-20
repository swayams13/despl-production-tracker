-- Lean Core J3a: route per equipment line.
-- Additive and forward-only. A line may now run a route (process template
-- version) other than the job's own; its UNIT-grain job_processes then carry the
-- line's id. Every existing job keeps its single route: its processes stay
-- equipment_id NULL, and its equipments are pinned to the job's own versions.

-- ── Equipment pins (invariant 9: a running line keeps its version) ──────────
ALTER TABLE "equipments" ADD COLUMN "template_version_id" INTEGER;
ALTER TABLE "equipments" ADD COLUMN "assembly_template_version_id" INTEGER;

ALTER TABLE "equipments"
  ADD CONSTRAINT "equipments_template_version_id_fkey"
  FOREIGN KEY ("template_version_id") REFERENCES "process_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "equipments"
  ADD CONSTRAINT "equipments_assembly_template_version_id_fkey"
  FOREIGN KEY ("assembly_template_version_id") REFERENCES "assembly_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "equipments_template_version_id_idx" ON "equipments"("template_version_id");
CREATE INDEX "equipments_assembly_template_version_id_idx" ON "equipments"("assembly_template_version_id");

-- Deterministic: every existing line runs its job's own route.
UPDATE "equipments" e
   SET "template_version_id" = j."template_version_id",
       "assembly_template_version_id" = j."assembly_template_version_id"
  FROM "jobs" j
 WHERE j."id" = e."job_id";

-- ── Line scope on job processes ──────────────────────────────────────────────
ALTER TABLE "job_processes" ADD COLUMN "equipment_id" INTEGER;
ALTER TABLE "job_processes"
  ADD CONSTRAINT "job_processes_equipment_id_fkey"
  FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "job_processes_equipment_id_idx" ON "job_processes"("equipment_id");

-- Order-level (JOB-grain) processes are never scoped to a line.
ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_line_scope_chk"
  CHECK ("equipment_id" IS NULL OR "grain" = 'UNIT');

-- One code per scope: the job-level set (equipment_id NULL) and each line's own set.
-- (Partial indexes, like schedule_runs_one_current_per_job; Prisma cannot express them.)
DROP INDEX "job_processes_job_id_code_key";
CREATE UNIQUE INDEX "job_processes_job_code_shared_key" ON "job_processes"("job_id", "code") WHERE "equipment_id" IS NULL;
CREATE UNIQUE INDEX "job_processes_job_line_code_key" ON "job_processes"("job_id", "equipment_id", "code") WHERE "equipment_id" IS NOT NULL;

-- A line's process must belong to the same job (no composite FK on a nullable column).
CREATE FUNCTION "job_processes_line_same_job"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."equipment_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "equipments" WHERE "id" = NEW."equipment_id" AND "job_id" = NEW."job_id"
  ) THEN
    RAISE EXCEPTION 'job_processes.equipment_id % does not belong to job %', NEW."equipment_id", NEW."job_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "job_processes_line_same_job_trg"
  BEFORE INSERT OR UPDATE OF "equipment_id", "job_id" ON "job_processes"
  FOR EACH ROW EXECUTE FUNCTION "job_processes_line_same_job"();
