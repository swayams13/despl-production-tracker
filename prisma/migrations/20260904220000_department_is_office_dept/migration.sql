-- Replaces command-center.read.ts's hardcoded OFFICE_DEPT_CODES/ALL_DEPT_CODES
-- literal arrays with real tenant-authored data. Behavior-preserving backfill:
-- the 6 codes below are exactly what those arrays already listed as "office".

ALTER TABLE "departments" ADD COLUMN "is_office_dept" BOOLEAN NOT NULL DEFAULT false;

UPDATE "departments"
SET "is_office_dept" = true
WHERE "code" IN ('PROJECTS', 'ENGINEERING', 'PLANNING', 'PROCUREMENT', 'QC', 'STORES');
