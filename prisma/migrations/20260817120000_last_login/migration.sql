-- Personal dashboards v1, Task 4.2: /admin Employees table "Last login"
-- column (SPEC §7.3). Additive, nullable — existing/seeded/imported rows
-- that have never authenticated stay NULL and render as "Never" rather than
-- a fabricated date.

ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMP(3);
