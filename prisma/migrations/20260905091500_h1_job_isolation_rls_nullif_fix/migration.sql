-- H1 — job-level RLS backstop, fixup: the job_isolation policy from
-- 20260905090000 could throw "invalid input syntax for type integer: ''"
-- when app.job_id has reset to the empty string (a pooled-connection GUC
-- reset artifact, not an unset value) on any indexed job_id column, because
-- Postgres's planner can evaluate the ::int cast at plan time independent of
-- the OR's other branches. Fix: NULLIF before cast, so the cast target is
-- never the literal ''.
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
    EXECUTE format('DROP POLICY IF EXISTS job_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY job_isolation ON %I
        USING (
          job_id IS NULL
          OR NULLIF(current_setting('app.job_id', true), '') IS NULL
          OR job_id = NULLIF(current_setting('app.job_id', true), '')::int
        )
        WITH CHECK (
          job_id IS NULL
          OR NULLIF(current_setting('app.job_id', true), '') IS NULL
          OR job_id = NULLIF(current_setting('app.job_id', true), '')::int
        )
    $f$, t);
  END LOOP;
END
$$;
