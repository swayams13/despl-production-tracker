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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'despl_web') THEN
    CREATE ROLE despl_web LOGIN PASSWORD :'despl_web_password';
  ELSE
    ALTER ROLE despl_web PASSWORD :'despl_web_password';
  END IF;
END
$$;

GRANT despl_app TO despl_web;
