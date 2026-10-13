-- Lean Core M1 — master-data schema (additive; no behaviour change).
--
--   * component_type_refs.kind        RAW_FORM (default) | PART_FAMILY
--   * part_families                   1:1 attributes of a PART_FAMILY type
--   * route_templates.variant         route variant letter, default 'A';
--                                     unique widened to include it
--   * route_steps                     department override, standard time
--                                     (stored only), condition, acceptance,
--                                     record document, requires_qc
--   * route_step_family_seqs          per-step stage mapping (mirrors
--                                     operation_ref_family_seqs)
--   * material_grades                 material master
--
-- Every new column on an existing table has a constant default or is
-- nullable, and no row is rewritten. DESPL-320 keeps resolving through its
-- RAW_FORM component types with variant 'A' and no step-level mapping, so its
-- routes regenerate unchanged. Nothing reads the new columns yet (PR B).
--
-- Widening route_templates' unique key only relaxes it, so no existing row can
-- violate it. The DROP and CREATE of that index are in this one migration.

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ComponentTypeKind" AS ENUM ('RAW_FORM', 'PART_FAMILY');

-- CreateEnum
CREATE TYPE "MasterDataStatus" AS ENUM ('DRAFT', 'REVIEWED', 'APPROVED');

-- CreateEnum
CREATE TYPE "EquipmentScope" AS ENUM ('PV', 'HE', 'BOTH');

-- CreateEnum
CREATE TYPE "PartMakeBuy" AS ENUM ('MADE_IN_HOUSE', 'BOUGHT_MACHINED', 'BOUGHT_OUT', 'BOUGHT_FABRICATED');

-- CreateEnum
CREATE TYPE "StdTimeUnit" AS ENUM ('HOURS', 'DAYS');

-- CreateEnum
CREATE TYPE "StdTimeBasis" AS ENUM ('PER_PIECE', 'PER_JOB', 'PER_MATERIAL_LOT', 'PER_METRE_CUT', 'PER_METRE_EDGE', 'PER_METRE_WELD', 'PER_JOINT', 'PER_HOLE', 'PER_TUBE', 'PER_KG');

-- CreateEnum
CREATE TYPE "StdTimeStatus" AS ENUM ('PROPOSED', 'VALIDATED');

-- DropIndex
DROP INDEX "route_templates_tenant_id_component_type_id_family_id_key";

-- AlterTable
ALTER TABLE "component_type_refs" ADD COLUMN     "kind" "ComponentTypeKind" NOT NULL DEFAULT 'RAW_FORM';

-- AlterTable
ALTER TABLE "route_templates" ADD COLUMN     "variant" TEXT NOT NULL DEFAULT 'A';

-- AlterTable
ALTER TABLE "route_steps" ADD COLUMN     "acceptance_standard" TEXT,
ADD COLUMN     "condition_text" TEXT,
ADD COLUMN     "department_id" INTEGER,
ADD COLUMN     "include_when" JSONB,
ADD COLUMN     "record_document" TEXT,
ADD COLUMN     "requires_qc" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "std_time" DECIMAL(8,3),
ADD COLUMN     "std_time_basis" "StdTimeBasis",
ADD COLUMN     "std_time_status" "StdTimeStatus" NOT NULL DEFAULT 'PROPOSED',
ADD COLUMN     "std_time_unit" "StdTimeUnit";

-- CreateTable
CREATE TABLE "route_step_family_seqs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "route_step_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "lead_time_process_seq" INTEGER NOT NULL,

    CONSTRAINT "route_step_family_seqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_families" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "component_type_id" INTEGER NOT NULL,
    "equipment_scope" "EquipmentScope" NOT NULL DEFAULT 'BOTH',
    "assembly_group" TEXT,
    "make_buy" "PartMakeBuy",
    "raw_form_id" INTEGER,
    "typical_moc" TEXT,
    "dimension_keys" JSONB,
    "weight_basis" TEXT,
    "is_spare" BOOLEAN NOT NULL DEFAULT false,
    "route_source" TEXT,
    "status" "MasterDataStatus" NOT NULL DEFAULT 'DRAFT',
    "prepared_by_id" INTEGER,
    "approved_by_id" INTEGER,
    "approved_at" TIMESTAMP(3),
    "remarks" TEXT,

    CONSTRAINT "part_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_grades" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "spec" TEXT NOT NULL,
    "grade" TEXT NOT NULL DEFAULT '',
    "product_form" TEXT NOT NULL,
    "density_gcc" DECIMAL(6,3),
    "remarks" TEXT,
    "status" "MasterDataStatus" NOT NULL DEFAULT 'DRAFT',

    CONSTRAINT "material_grades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "route_step_family_seqs_tenant_id_idx" ON "route_step_family_seqs"("tenant_id");

-- CreateIndex
CREATE INDEX "route_step_family_seqs_family_id_lead_time_process_seq_idx" ON "route_step_family_seqs"("family_id", "lead_time_process_seq");

-- CreateIndex
CREATE UNIQUE INDEX "route_step_family_seqs_route_step_id_family_id_key" ON "route_step_family_seqs"("route_step_id", "family_id");

-- CreateIndex
CREATE UNIQUE INDEX "part_families_component_type_id_key" ON "part_families"("component_type_id");

-- CreateIndex
CREATE INDEX "part_families_tenant_id_idx" ON "part_families"("tenant_id");

-- CreateIndex
CREATE INDEX "part_families_tenant_id_status_idx" ON "part_families"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "part_families_raw_form_id_idx" ON "part_families"("raw_form_id");

-- CreateIndex
CREATE INDEX "material_grades_tenant_id_idx" ON "material_grades"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_grades_tenant_id_spec_grade_product_form_key" ON "material_grades"("tenant_id", "spec", "grade", "product_form");

-- CreateIndex
CREATE UNIQUE INDEX "route_templates_tenant_id_component_type_id_family_id_varia_key" ON "route_templates"("tenant_id", "component_type_id", "family_id", "variant");

-- CreateIndex
CREATE INDEX "route_steps_department_id_idx" ON "route_steps"("department_id");

-- AddForeignKey
ALTER TABLE "route_steps" ADD CONSTRAINT "route_steps_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_step_family_seqs" ADD CONSTRAINT "route_step_family_seqs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_step_family_seqs" ADD CONSTRAINT "route_step_family_seqs_route_step_id_fkey" FOREIGN KEY ("route_step_id") REFERENCES "route_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_step_family_seqs" ADD CONSTRAINT "route_step_family_seqs_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_component_type_id_fkey" FOREIGN KEY ("component_type_id") REFERENCES "component_type_refs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_raw_form_id_fkey" FOREIGN KEY ("raw_form_id") REFERENCES "component_type_refs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_prepared_by_id_fkey" FOREIGN KEY ("prepared_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_grades" ADD CONSTRAINT "material_grades_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Checks ──────────────────────────────────────────────────────────────
-- Maker–checker at the DB level for part-family approval: the approver is
-- never the recorded preparer, and APPROVED needs an approver and a date.
-- An imported row may have no preparer user ("Filled by" is a company in the
-- workbook), so the service layer (M3) must also refuse approver == preparer
-- when the preparer becomes known.
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_approver_not_preparer_chk"
  CHECK ("approved_by_id" IS NULL OR "prepared_by_id" IS NULL OR "approved_by_id" <> "prepared_by_id");
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_approved_needs_approver_chk"
  CHECK ("status" <> 'APPROVED' OR ("approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL));

ALTER TABLE "route_steps" ADD CONSTRAINT "route_steps_std_time_chk"
  CHECK ("std_time" IS NULL OR ("std_time" >= 0 AND "std_time_unit" IS NOT NULL AND "std_time_basis" IS NOT NULL));

ALTER TABLE "route_templates" ADD CONSTRAINT "route_templates_variant_chk"
  CHECK ("variant" ~ '^[A-Z]$');

ALTER TABLE "material_grades" ADD CONSTRAINT "material_grades_density_chk"
  CHECK ("density_gcc" IS NULL OR "density_gcc" > 0);

-- ── Row-level security ──────────────────────────────────────────────────
-- The three new tables carry tenant_id: tenant-root, same policy as
-- operation_ref_family_seqs / equipment_type_refs. Table privileges come from
-- the default privileges for despl_app, as for every earlier table.
ALTER TABLE "route_step_family_seqs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "route_step_family_seqs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);

ALTER TABLE "part_families" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "part_families"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);

ALTER TABLE "material_grades" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "material_grades"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);
