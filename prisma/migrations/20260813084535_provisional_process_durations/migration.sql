-- AlterTable
ALTER TABLE "job_processes" ADD COLUMN     "provisional" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "duration_min_days" DROP NOT NULL,
ALTER COLUMN "duration_max_days" DROP NOT NULL,
ALTER COLUMN "envelope_finish_by_min_days" DROP NOT NULL,
ALTER COLUMN "envelope_finish_by_max_days" DROP NOT NULL;

-- AlterTable
ALTER TABLE "template_processes" ADD COLUMN     "provisional" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "duration_min_days" DROP NOT NULL,
ALTER COLUMN "duration_max_days" DROP NOT NULL,
ALTER COLUMN "envelope_finish_by_min_days" DROP NOT NULL,
ALTER COLUMN "envelope_finish_by_max_days" DROP NOT NULL,
ALTER COLUMN "envelope_start_by_min_days" DROP NOT NULL,
ALTER COLUMN "envelope_start_by_max_days" DROP NOT NULL;
