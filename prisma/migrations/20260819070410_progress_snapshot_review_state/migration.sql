/*
  Warnings:

  - A unique constraint covering the columns `[job_id,unit_id,as_of]` on the table `progress_snapshots` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ProgressSnapshotStatus" AS ENUM ('PUBLISHED', 'VERIFIED', 'REJECTED');

-- AlterTable
ALTER TABLE "progress_snapshots" ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "status" "ProgressSnapshotStatus" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN     "verified_at" TIMESTAMP(3),
ADD COLUMN     "verified_by" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "progress_snapshots_job_id_unit_id_as_of_key" ON "progress_snapshots"("job_id", "unit_id", "as_of");
