-- AUD-078 — step 3 of 3: replace the library-exempt "tenant_id IS NULL OR
-- ..." tenant_isolation policy AUD-080 gave these 4 tables with the strict,
-- unconditional equality every other tenant-anchored table already uses.
-- job_isolation (unchanged, still the sole PERMISSIVE policy on these
-- tables) keeps its own separate job_id IS NULL fail-open branch, which is
-- about cross-job visibility WITHIN a tenant and is untouched by this —
-- AUD-078 is only about the tenant boundary.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'qcp_templates', 'qcp_items', 'inspection_parties', 'qcp_item_party_codes'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
    $f$, t);
  END LOOP;
END
$$;
