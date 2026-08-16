-- Personal dashboards v1, Task 1.1: person grain on User + assignment column
-- on ProcessPlan. Additive only — no dropped/renamed columns, no data loss.
--
-- username: added nullable, backfilled from the email local-part for all
-- existing rows, then made NOT NULL. Tenant-scoped unique (matches `email`'s
-- own [tenant_id, email] scoping — see the doc comment on User.username in
-- schema.prisma for why this deviates from a plain global @unique).
--
-- employee_code: already existed as nullable; this only adds a tenant-scoped
-- unique constraint. Verified against live data (see task report) that no
-- tenant currently has two rows sharing a non-null employee_code, so no
-- backfill is needed — Postgres also allows unlimited NULLs under a unique
-- constraint.
--
-- must_change_password: added nullable, ALL existing rows explicitly
-- backfilled to false (they already have working passwords and must not be
-- locked out), then made NOT NULL DEFAULT true so only new rows default to
-- requiring a password change.

-- ── users.username ───────────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "username" TEXT;

UPDATE "users" SET "username" = split_part("email", '@', 1);

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;

CREATE UNIQUE INDEX "users_tenant_id_username_key" ON "users"("tenant_id", "username");

-- ── users.employee_code ──────────────────────────────────────────────────
CREATE UNIQUE INDEX "users_tenant_id_employee_code_key" ON "users"("tenant_id", "employee_code");

-- ── users.must_change_password ───────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN;

UPDATE "users" SET "must_change_password" = false;

ALTER TABLE "users" ALTER COLUMN "must_change_password" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "must_change_password" SET DEFAULT true;

-- ── process_plans.assignee_user_id ───────────────────────────────────────
-- NULL = unassigned, sits in the department pool (Task 1.2's concern).
ALTER TABLE "process_plans" ADD COLUMN "assignee_user_id" INTEGER;

CREATE INDEX "process_plans_assignee_user_id_status_idx" ON "process_plans"("assignee_user_id", "status");

ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_assignee_user_id_fkey"
  FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
