-- AUD-001 — tenant-grain RLS backstop, step 3 of 3: the actual floor policy.
--
-- Composition, verified LIVE against despl_test on 9 Sep 2026 (not just read
-- from the DDL — see PR description for the exact five-query script and
-- results): Postgres ORs all PERMISSIVE policies for a command, then ANDs the
-- result with every RESTRICTIVE policy. job_isolation on these 28 tables is
-- (and stays) the sole PERMISSIVE policy — untouched, same DROP/CREATE-free
-- treatment as every other migration since 20260905091500. Adding
-- tenant_isolation here AS RESTRICTIVE is therefore enough on its own to AND
-- a tenant floor under job_isolation's fail-open OR; no change to
-- job_isolation is needed OR safe. (Retyping job_isolation itself to
-- RESTRICTIVE, which one reading of the audit's note could suggest, was
-- tried and rejected: with zero remaining PERMISSIVE policies on the table,
-- Postgres denies all access unconditionally regardless of any RESTRICTIVE
-- policy's predicate — that would take down every legitimate cross-job read
-- job_isolation exists to allow. Verified this is real Postgres RLS default-
-- deny behavior, not assumed.)
--
-- Verified live, all four required properties, in the same session:
--   1. tenant GUC = correct tenant, no job GUC -> cross-job rows within that
--      tenant still visible (job_isolation's fail-open preserved)
--   2. tenant GUC = wrong tenant (a real other-tenant row's id) -> zero rows
--   3. same but with the job GUC ALSO pointed at the victim row's real job_id
--      (misconfiguration/attack simulation) -> still zero rows
--   4. cross-tenant UPDATE -> zero rows affected
--   5. no tenant GUC set at all -> zero rows (fails closed, matching every
--      other tenant_isolation-covered table)
--
-- qcp_items / inspection_parties / qcp_item_party_codes: tenant_id stays
-- nullable (step 2) for library rows with no owning job at all. Their
-- predicate below adds `tenant_id IS NULL OR ...` — the same fail-open
-- shape job_isolation itself uses for job_id IS NULL on these same three
-- tables — so a library row stays visible to every tenant (as it already is
-- via job_isolation) rather than becoming invisible to everyone once
-- tenant_id is compared. This is a deliberate, narrower exception mirroring
-- H1's own precedent for exactly these three tables, not a general fail-open
-- default; the other 25 tables get the strict, unconditional equality below.

DO $$
DECLARE
  t text;
  strict_tables text[] := ARRAY[
    'units', 'bom_revisions', 'bom_items', 'components',
    'job_process_edges', 'process_plans', 'weld_joint_welders',
    'ndt_results', 'drawing_revisions', 'dispatch_batch_units',
    'component_operations', 'component_operation_rejections',
    'paint_records', 'dft_readings', 'assembly_steps',
    'assembly_step_rejections', 'ncrs', 'qcp_executions',
    'qcp_item_processes', 'delay_reasons', 'stock_lots', 'stock_txns',
    'procurement_events', 'material_identifications', 'item_tests'
  ];
  library_exempt_tables text[] := ARRAY[
    'qcp_items', 'inspection_parties', 'qcp_item_party_codes'
  ];
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
