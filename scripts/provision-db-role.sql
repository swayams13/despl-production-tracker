-- Provisions the application's login role, `despl_web`.
--
-- despl_app (the NOLOGIN permission bundle: RLS policies, the audit_log
-- REVOKE) is created by the migration in
-- prisma/migrations/20260813051500_rls_and_app_role/migration.sql. This
-- script creates the actual login role each environment connects as via
-- DATABASE_URL, and grants it that bundle. It replaces the old
-- migration-comment-only description of this step — run it for real once per
-- environment, as the table owner (the DIRECT_URL role):
--
--   psql "$DIRECT_URL" -v despl_web_password="$DESPL_WEB_PASSWORD" -f scripts/provision-db-role.sql
--
-- Never commit a real password here — :'despl_web_password' is a psql
-- variable substituted at run time from the environment above.
--
-- The substitution happens in a top-level SELECT (via \gexec), not inside a
-- DO $$ ... $$ block — psql does not interpolate :'var' inside dollar-quoted
-- bodies (they're expected to hold literal text, e.g. array-slice colons),
-- so a substitution placed there is sent to the server unexpanded.

SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'despl_web')
  THEN format('ALTER ROLE despl_web PASSWORD %L', :'despl_web_password')
  ELSE format('CREATE ROLE despl_web LOGIN PASSWORD %L', :'despl_web_password')
END
\gexec

GRANT despl_app TO despl_web;

-- Pin this role's default session timezone to UTC (CLAUDE.md: "store UTC,
-- display IST"). Without this, it depends on the Postgres server's own
-- `timezone` GUC default, which is NOT guaranteed to be UTC (Homebrew/local
-- installs default to the host OS's zone at initdb time). That gap is real,
-- not theoretical: it was caught live during Task 4.4's browser pass — every
-- naive `timestamp without time zone` column (domain_events.at, etc.) stores
-- literal UTC-clock digits (Prisma's query engine computes now() in UTC and
-- Postgres stores the digits verbatim, ignoring any tz suffix on the bound
-- parameter), but a raw-SQL comparison against a JS Date parameter
-- (`de.at >= ${someDate}`, as myday.read.ts's clearedToday does) makes
-- Postgres implicitly cast the naive column to timestamptz using the
-- CURRENT SESSION's timezone — silently shifting the comparison by the
-- server's UTC/local offset. On a server whose default is Asia/Kolkata
-- (+05:30), that reliably knocked "SUBMITTED today" counts to 0 for anything
-- submitted before the day's last 5.5 hours. Existing regression coverage:
-- myday.read.test.ts "counts today's COMPLETE + today's SUBMITTED, and only
-- today's" — it was already asserting the right thing and started failing
-- the moment the DB's default drifted from UTC, which is exactly what
-- surfaced this. Idempotent; safe to re-run.
ALTER ROLE despl_web SET timezone = 'UTC';
