-- CreateEnum
CREATE TYPE "AssemblyStepKind" AS ENUM ('WORK', 'INSPECTION');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "assembly_template_version_id" INTEGER;

-- AlterTable
ALTER TABLE "weld_joints" ADD COLUMN     "component_id" INTEGER;

-- CreateTable
CREATE TABLE "assembly_templates" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "assembly_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assembly_template_versions" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "assembly_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assembly_template_steps" (
    "id" SERIAL NOT NULL,
    "version_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "group_code" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "sr_no" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "kind" "AssemblyStepKind" NOT NULL,
    "default_department_id" INTEGER NOT NULL,
    "qcp_sr_no" TEXT,
    "joint_ref" TEXT,

    CONSTRAINT "assembly_template_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assembly_steps" (
    "id" SERIAL NOT NULL,
    "unit_id" INTEGER NOT NULL,
    "template_step_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "performed_by_welder_id" INTEGER,
    "performed_by_user_id" INTEGER,
    "submitted_by" INTEGER,
    "verified_by" INTEGER,
    "weld_joint_id" INTEGER,
    "qcp_item_id" INTEGER,
    "remarks" TEXT,

    CONSTRAINT "assembly_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assembly_step_rejections" (
    "id" SERIAL NOT NULL,
    "assembly_step_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "detail" TEXT,
    "rejected_by" INTEGER NOT NULL,
    "rejected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assembly_step_rejections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assembly_templates_tenant_id_idx" ON "assembly_templates"("tenant_id");

-- CreateIndex
CREATE INDEX "assembly_templates_family_id_idx" ON "assembly_templates"("family_id");

-- CreateIndex
CREATE INDEX "assembly_template_versions_template_id_idx" ON "assembly_template_versions"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "assembly_template_versions_template_id_version_key" ON "assembly_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "assembly_template_steps_version_id_idx" ON "assembly_template_steps"("version_id");

-- CreateIndex
CREATE INDEX "assembly_template_steps_default_department_id_idx" ON "assembly_template_steps"("default_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "assembly_template_steps_version_id_seq_key" ON "assembly_template_steps"("version_id", "seq");

-- CreateIndex
CREATE INDEX "assembly_steps_unit_id_idx" ON "assembly_steps"("unit_id");

-- CreateIndex
CREATE INDEX "assembly_steps_template_step_id_idx" ON "assembly_steps"("template_step_id");

-- CreateIndex
CREATE INDEX "assembly_steps_status_idx" ON "assembly_steps"("status");

-- CreateIndex
CREATE INDEX "assembly_steps_weld_joint_id_idx" ON "assembly_steps"("weld_joint_id");

-- CreateIndex
CREATE INDEX "assembly_steps_qcp_item_id_idx" ON "assembly_steps"("qcp_item_id");

-- CreateIndex
CREATE INDEX "assembly_steps_performed_by_welder_id_idx" ON "assembly_steps"("performed_by_welder_id");

-- CreateIndex
CREATE INDEX "assembly_steps_performed_by_user_id_idx" ON "assembly_steps"("performed_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "assembly_steps_unit_id_seq_key" ON "assembly_steps"("unit_id", "seq");

-- CreateIndex
CREATE INDEX "assembly_step_rejections_assembly_step_id_idx" ON "assembly_step_rejections"("assembly_step_id");

-- CreateIndex
CREATE INDEX "assembly_step_rejections_category_id_idx" ON "assembly_step_rejections"("category_id");

-- CreateIndex
CREATE INDEX "jobs_assembly_template_version_id_idx" ON "jobs"("assembly_template_version_id");

-- CreateIndex
CREATE INDEX "weld_joints_component_id_idx" ON "weld_joints"("component_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assembly_template_version_id_fkey" FOREIGN KEY ("assembly_template_version_id") REFERENCES "assembly_template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weld_joints" ADD CONSTRAINT "weld_joints_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_templates" ADD CONSTRAINT "assembly_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_templates" ADD CONSTRAINT "assembly_templates_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_template_versions" ADD CONSTRAINT "assembly_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "assembly_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_template_steps" ADD CONSTRAINT "assembly_template_steps_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "assembly_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_template_steps" ADD CONSTRAINT "assembly_template_steps_default_department_id_fkey" FOREIGN KEY ("default_department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_template_step_id_fkey" FOREIGN KEY ("template_step_id") REFERENCES "assembly_template_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_weld_joint_id_fkey" FOREIGN KEY ("weld_joint_id") REFERENCES "weld_joints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_qcp_item_id_fkey" FOREIGN KEY ("qcp_item_id") REFERENCES "qcp_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_performed_by_welder_id_fkey" FOREIGN KEY ("performed_by_welder_id") REFERENCES "welders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_performed_by_user_id_fkey" FOREIGN KEY ("performed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_step_rejections" ADD CONSTRAINT "assembly_step_rejections_assembly_step_id_fkey" FOREIGN KEY ("assembly_step_id") REFERENCES "assembly_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_step_rejections" ADD CONSTRAINT "assembly_step_rejections_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "delay_category_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
