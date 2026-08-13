-- Make tenant isolation FAIL CLOSED.
--
-- The previous policy treated an unset app.tenant_id as a maintenance context
-- and returned every row. That is fail-open: one missed set_config in the
-- application and a request silently reads across tenants. CLAUDE.md requires
-- deny-by-default, and violation paths must fail closed, not open.
--
-- New behaviour, for the application (non-owner) role:
--   app.tenant_id set   -> only that tenant's rows
--   app.tenant_id unset -> ZERO rows, on read and on write
--
-- An unset variable now produces an immediately visible empty result rather
-- than a silent cross-tenant leak. Migrations and prisma/seed.ts are unaffected
-- because they connect as the table owner, which is not subject to RLS (the
-- tables are ENABLE, not FORCE, ROW LEVEL SECURITY).

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
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
    $f$, t);
  END LOOP;
END
$$;
