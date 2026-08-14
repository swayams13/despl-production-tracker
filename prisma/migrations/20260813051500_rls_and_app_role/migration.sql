-- Security layer: append-only audit (invariant #5) + tenant Row Level Security.
--
-- ROLE MODEL
--   despl_app   NOLOGIN permission bundle. Safe to commit — carries no password.
--   <env login> Each environment creates its own login role and is GRANTed
--               despl_app by running scripts/provision-db-role.sql as the
--               table owner. Never put a password in a migration.
--
-- WHY THIS MATTERS: the previous schema's `REVOKE ... FROM PUBLIC` was a
-- documented no-op, because the app connected as the postgres superuser and
-- superusers bypass grants entirely. Invariant #5 was unenforced. Revoking
-- from a real, non-superuser role is what makes it bite.
--
-- RLS applies to the tenant-root tables (those carrying tenant_id). Child rows
-- are only reachable through a tenant-scoped parent, and the service layer
-- scopes every query. Table OWNER (postgres) is not FORCEd, so migrations and
-- the seed script continue to work; the application connects as a non-owner
-- login role, where the policies do apply.
--
-- ponytail: child tables rely on reachability + service-layer scoping rather
-- than their own tenant_id column. When a second tenant actually goes live,
-- denormalise tenant_id onto the child tables and extend the loop below.

-- ── Permission bundle role ──────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'despl_app') THEN
    CREATE ROLE despl_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO despl_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO despl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO despl_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO despl_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO despl_app;

-- ── Invariant #5: audit and event streams are append-only ───────────────
REVOKE UPDATE, DELETE ON "audit_log" FROM despl_app;
REVOKE UPDATE, DELETE ON "domain_events" FROM despl_app;

-- ── Tenant Row Level Security ───────────────────────────────────────────
-- Policy: a row is visible when app.tenant_id is unset (maintenance context)
-- or matches the row's tenant. Application connections always set it.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'clients', 'users', 'roles', 'departments',
    'component_type_refs', 'operation_refs', 'test_type_refs',
    'drawing_type_refs', 'delay_category_refs', 'qcp_code_refs',
    'work_calendars', 'product_families', 'process_templates',
    'jobs', 'route_templates', 'notifications', 'progress_snapshots',
    'audit_log', 'domain_events'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.tenant_id', true) IS NULL
          OR current_setting('app.tenant_id', true) = ''
          OR tenant_id = current_setting('app.tenant_id', true)::int
        )
        WITH CHECK (
          current_setting('app.tenant_id', true) IS NULL
          OR current_setting('app.tenant_id', true) = ''
          OR tenant_id = current_setting('app.tenant_id', true)::int
        )
    $f$, t);
  END LOOP;
END
$$;
