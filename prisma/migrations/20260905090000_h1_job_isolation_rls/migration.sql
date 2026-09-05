-- H1 — job-level RLS backstop, step 3 of 4: the actual backstop policy.
--
-- Unlike tenant_isolation (fail-CLOSED as of 20260813052000_rls_fail_closed),
-- job_isolation is fail-OPEN, PERMANENTLY, by design: most reads in this app
-- are intentionally cross-job within a tenant (dashboard, portfolio, job
-- list, my-day, command-center, notifications — see
-- docs/superpowers/plans/2026-09-05-h1-job-level-rls-backstop.md's "Do not
-- touch" list). Only a service function that explicitly calls the new
-- withJob() wrapper (src/lib/db.ts) sets app.job_id, and only then does this
-- policy narrow the result set — catching exactly the "id from Job B passed
-- into a Job A operation" class of bug named in the architecture doc's §4.
DO $$
DECLARE
  t text;
  job_tables text[] := ARRAY[
    'units', 'bom_revisions', 'bom_items', 'components',
    'job_process_edges', 'process_plans', 'weld_joint_welders',
    'ndt_results', 'drawing_revisions', 'dispatch_batch_units',
    'inspection_parties', 'qcp_items', 'component_operations',
    'component_operation_rejections', 'paint_records', 'dft_readings',
    'assembly_steps', 'assembly_step_rejections', 'ncrs',
    'qcp_executions', 'qcp_item_processes', 'qcp_item_party_codes',
    'delay_reasons', 'stock_lots', 'stock_txns', 'procurement_events',
    'material_identifications', 'item_tests'
  ];
BEGIN
  FOREACH t IN ARRAY job_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS job_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY job_isolation ON %I
        USING (
          job_id IS NULL
          OR current_setting('app.job_id', true) IS NULL
          OR current_setting('app.job_id', true) = ''
          OR job_id = current_setting('app.job_id', true)::int
        )
        WITH CHECK (
          job_id IS NULL
          OR current_setting('app.job_id', true) IS NULL
          OR current_setting('app.job_id', true) = ''
          OR job_id = current_setting('app.job_id', true)::int
        )
    $f$, t);
  END LOOP;
END
$$;
