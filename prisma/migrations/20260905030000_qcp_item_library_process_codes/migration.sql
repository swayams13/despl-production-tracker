-- C7: a from-scratch-authored library QcpItem (its QcpTemplate.jobId is
-- null) needs to declare which process code(s) it gates before any real
-- Job/JobProcess exists to link against via qcp_item_processes. Plain
-- additive column, same array-of-scalars pattern as
-- template_processes.work_order_stages. No backfill needed — existing rows
-- (job-owned items, which ignore this column) get an empty array.

-- AlterTable
ALTER TABLE "qcp_items" ADD COLUMN "library_process_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
