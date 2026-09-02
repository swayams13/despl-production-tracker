-- v_process_plan_percent — the single per-ProcessPlan completion definition
-- (Phase 3, R1/R3, addendum §3). One row per ProcessPlan belonging to a
-- CURRENT schedule run. `percent` is the fabrication/assembly-mapped-ops
-- fraction for (jobProcess, unit) when this process has any mapped
-- ComponentOperation/AssemblyStep, else the pre-Phase-3 binary plan status
-- (0/100) — same SEAM discipline as `assertNoOpenHoldPoint`. `weight` is
-- `JobProcess.durationMaxDays` (falls back to 1), so a job/unit rollup that
-- sums percent*weight / sum(weight) is duration-weighted, not a flat count
-- (audit's unweighted-count finding). Every consumer of "percent complete"
-- (jobs list, job header, dashboard KPIs, client portal) computes its
-- aggregate from THIS view so they can no longer disagree by construction.
--
-- security_invoker = true for the same reason as v_unit_stage_status: the
-- underlying tables' tenant RLS must be evaluated as the querying role, not
-- the view owner.
--
-- ponytail: four correlated subqueries per row is fine at pilot scale (one
-- job, ~9 units, 36 processes = a few hundred plan rows); if the process
-- count grows enough to matter, replace with a pre-aggregated join.

CREATE VIEW v_process_plan_percent
WITH (security_invoker = true) AS
SELECT
  pp.id            AS process_plan_id,
  jp.job_id        AS job_id,
  pp.unit_id       AS unit_id,
  pp.job_process_id AS job_process_id,
  COALESCE(jp.duration_max_days, 1) AS weight,
  CASE
    WHEN mapped.total > 0 THEN (mapped.complete::numeric / mapped.total) * 100
    WHEN pp.status = 'COMPLETE' THEN 100
    ELSE 0
  END AS percent
FROM process_plans pp
JOIN schedule_runs sr ON sr.id = pp.schedule_run_id AND sr.is_current = true
JOIN job_processes jp ON jp.id = pp.job_process_id
CROSS JOIN LATERAL (
  SELECT CASE WHEN pp.unit_id IS NOT NULL AND jp.code ~ '^[0-9]+$' THEN jp.code::int END AS lt_seq
) seq
CROSS JOIN LATERAL (
  SELECT
    COALESCE((
      SELECT count(*) FROM component_operations co
      JOIN components c ON c.id = co.component_id
      JOIN operation_refs orf ON orf.id = co.operation_id
      WHERE c.unit_id = pp.unit_id AND orf.lead_time_process_seq = seq.lt_seq
    ), 0)
    + COALESCE((
      SELECT count(*) FROM assembly_steps asm
      JOIN assembly_template_steps ats ON ats.id = asm.template_step_id
      WHERE asm.unit_id = pp.unit_id AND ats.lead_time_process_seq = seq.lt_seq
    ), 0) AS total,
    COALESCE((
      SELECT count(*) FROM component_operations co
      JOIN components c ON c.id = co.component_id
      JOIN operation_refs orf ON orf.id = co.operation_id
      WHERE c.unit_id = pp.unit_id AND orf.lead_time_process_seq = seq.lt_seq AND co.status = 'COMPLETE'
    ), 0)
    + COALESCE((
      SELECT count(*) FROM assembly_steps asm
      JOIN assembly_template_steps ats ON ats.id = asm.template_step_id
      WHERE asm.unit_id = pp.unit_id AND ats.lead_time_process_seq = seq.lt_seq AND asm.status = 'COMPLETE'
    ), 0) AS complete
) mapped;

GRANT SELECT ON v_process_plan_percent TO despl_web;
