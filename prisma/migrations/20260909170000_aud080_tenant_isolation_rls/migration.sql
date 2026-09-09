-- AUD-080 — step 4 of 5: the tenant floor, RESTRICTIVE, verbatim copy of
-- 20260909120000_aud001_tenant_isolation_rls's shape.
--
-- job_isolation (step 1, this batch) is the sole PERMISSIVE policy on these
-- nine tables — same composition as the AUD-001 batch: Postgres ORs all
-- PERMISSIVE policies then ANDs the result with every RESTRICTIVE policy, so
-- adding tenant_isolation here AS RESTRICTIVE is enough on its own to AND a
-- tenant floor under job_isolation's fail-open OR.
--
-- qcp_templates: library-exempt, same shape as qcp_items/inspection_parties/
-- qcp_item_party_codes — `tenant_id IS NULL OR ...` so a genuine library row
-- stays visible to every tenant (as it already is via job_isolation) rather
-- than becoming invisible to everyone once tenant_id is compared. This is
-- the mechanical RLS-coverage fix (AUD-080); it does not resolve AUD-078's
-- separate, still-open product question about whether that fail-open
-- visibility is the right posture for library content long-term.

DO $$
DECLARE
  t text;
  strict_tables text[] := ARRAY[
    'equipments', 'packages', 'job_processes', 'schedule_runs',
    'weld_joints', 'weld_logs', 'assembly_drawings', 'dispatch_batches'
  ];
  library_exempt_tables text[] := ARRAY['qcp_templates'];
BEGIN
  FOREACH t IN ARRAY strict_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
    $f$, t);
  END LOOP;

  FOREACH t IN ARRAY library_exempt_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE
        USING (
          tenant_id IS NULL
          OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
        )
        WITH CHECK (
          tenant_id IS NULL
          OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
        )
    $f$, t);
  END LOOP;
END
$$;
