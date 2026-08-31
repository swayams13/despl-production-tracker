-- CreateEnum
CREATE TYPE "NcrDisposition" AS ENUM ('USE_AS_IS', 'REPAIR', 'REWORK', 'SCRAP', 'CONCESSION');

-- CreateEnum
CREATE TYPE "NcrStatus" AS ENUM ('OPEN', 'DISPOSITIONED', 'REWORK_IN_PROGRESS', 'CLOSED');

-- CreateEnum
CREATE TYPE "ProcessEvidenceKind" AS ENUM ('MDR_COMPILED', 'PACKING_DONE', 'DISPATCH_RECORDED');

-- AlterTable
ALTER TABLE "template_processes" ADD COLUMN "evidence_kind" "ProcessEvidenceKind";

-- CreateTable
CREATE TABLE "paint_records" (
    "id" SERIAL NOT NULL,
    "component_operation_id" INTEGER NOT NULL,
    "coating_system" TEXT NOT NULL,
    "coats_planned" INTEGER,

    CONSTRAINT "paint_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dft_readings" (
    "id" SERIAL NOT NULL,
    "component_operation_id" INTEGER NOT NULL,
    "coat_number" INTEGER,
    "location" TEXT,
    "reading_microns" INTEGER NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "recorded_by" INTEGER NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dft_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "package_no" TEXT NOT NULL,
    "weight_kg" DECIMAL(65,30),
    "length_mm" INTEGER,
    "width_mm" INTEGER,
    "height_mm" INTEGER,
    "preservation_notes" TEXT,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_batch_units" (
    "id" SERIAL NOT NULL,
    "dispatch_batch_id" INTEGER NOT NULL,
    "unit_id" INTEGER NOT NULL,

    CONSTRAINT "dispatch_batch_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ncrs" (
    "id" SERIAL NOT NULL,
    "component_operation_rejection_id" INTEGER,
    "assembly_step_rejection_id" INTEGER,
    "status" "NcrStatus" NOT NULL DEFAULT 'OPEN',
    "disposition" "NcrDisposition",
    "dispositioned_by" INTEGER,
    "dispositioned_at" TIMESTAMP(3),
    "disposition_notes" TEXT,
    "rework_owner_id" INTEGER,
    "rework_due_date" TIMESTAMP(3),
    "rework_started_at" TIMESTAMP(3),
    "rework_finished_at" TIMESTAMP(3),
    "closed_by" INTEGER,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "ncrs_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "units" ADD COLUMN "package_id" INTEGER;

-- AlterTable
ALTER TABLE "dispatch_batches" ADD COLUMN "dispatch_note_no" TEXT,
ADD COLUMN "gate_pass_no" TEXT,
ADD COLUMN "vehicle_no" TEXT,
ADD COLUMN "lr_no" TEXT,
ADD COLUMN "release_approved_by" INTEGER,
ADD COLUMN "release_approved_at" TIMESTAMP(3),
ADD COLUMN "actual_dispatch_date" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "paint_records_component_operation_id_key" ON "paint_records"("component_operation_id");

-- CreateIndex
CREATE INDEX "dft_readings_component_operation_id_idx" ON "dft_readings"("component_operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "packages_job_id_package_no_key" ON "packages"("job_id", "package_no");

-- CreateIndex
CREATE INDEX "packages_job_id_idx" ON "packages"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_batch_units_dispatch_batch_id_unit_id_key" ON "dispatch_batch_units"("dispatch_batch_id", "unit_id");

-- CreateIndex
CREATE INDEX "dispatch_batch_units_dispatch_batch_id_idx" ON "dispatch_batch_units"("dispatch_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "ncrs_component_operation_rejection_id_key" ON "ncrs"("component_operation_rejection_id");

-- CreateIndex
CREATE UNIQUE INDEX "ncrs_assembly_step_rejection_id_key" ON "ncrs"("assembly_step_rejection_id");

-- CreateIndex
CREATE INDEX "ncrs_status_idx" ON "ncrs"("status");

-- CreateIndex
CREATE INDEX "units_package_id_idx" ON "units"("package_id");

-- AddForeignKey
ALTER TABLE "paint_records" ADD CONSTRAINT "paint_records_component_operation_id_fkey" FOREIGN KEY ("component_operation_id") REFERENCES "component_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dft_readings" ADD CONSTRAINT "dft_readings_component_operation_id_fkey" FOREIGN KEY ("component_operation_id") REFERENCES "component_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dft_readings" ADD CONSTRAINT "dft_readings_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_batch_units" ADD CONSTRAINT "dispatch_batch_units_dispatch_batch_id_fkey" FOREIGN KEY ("dispatch_batch_id") REFERENCES "dispatch_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_batch_units" ADD CONSTRAINT "dispatch_batch_units_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_component_operation_rejection_id_fkey" FOREIGN KEY ("component_operation_rejection_id") REFERENCES "component_operation_rejections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_assembly_step_rejection_id_fkey" FOREIGN KEY ("assembly_step_rejection_id") REFERENCES "assembly_step_rejections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_dispositioned_by_fkey" FOREIGN KEY ("dispositioned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_rework_owner_id_fkey" FOREIGN KEY ("rework_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_release_approved_by_fkey" FOREIGN KEY ("release_approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddConstraint for NCR exactly-one-of-two-FKs CHECK constraint
ALTER TABLE "ncrs" ADD CONSTRAINT "ncr_exactly_one_source" CHECK (
  (component_operation_rejection_id IS NOT NULL)::int +
  (assembly_step_rejection_id IS NOT NULL)::int = 1
);
