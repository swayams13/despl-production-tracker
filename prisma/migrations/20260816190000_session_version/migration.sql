-- Personal dashboards v1, Task 1.3: first-login password change.
--
-- session_version: additive, NOT NULL DEFAULT 0. Unlike must_change_password
-- (Task 1.1), no explicit backfill UPDATE is needed here — every existing row
-- gets 0 directly from the column default (a constant default on ADD COLUMN
-- is applied to existing rows without a table rewrite on Postgres 11+, and 0
-- is exactly the value every pre-existing session should start counting
-- from). Bumped by `changeOwnPassword` (src/lib/auth/change-password.ts) to
-- invalidate every previously-issued session token except the one just
-- refreshed.

ALTER TABLE "users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
