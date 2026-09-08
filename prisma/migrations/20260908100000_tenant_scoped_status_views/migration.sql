-- AUD-002 (interim compensating control) — v_unit_stage_status and
-- v_process_plan_percent both read job-grain tables (units/equipments/
-- job_processes/process_plans) that carry only the fail-open `job_isolation`
-- policy (AUD-001). security_invoker=true is correct but has nothing
-- tenant-scoped to invoke against, so both views return every tenant's rows
-- on the normal read path (no app.job_id set). Fix: join through `jobs`,
-- which carries the fail-closed `tenant_isolation` policy, with an explicit
-- tenant_id predicate. This does NOT fix AUD-001 — units/equipments/
-- job_processes/process_plans are still fail-open for any other query that
-- reads them directly without going through these views.
--
-- NULLIF(current_setting('app.tenant_id', true), '') matches the pattern
-- fixed in 20260905091500_h1_job_isolation_rls_nullif_fix: a bare ::int cast
-- throws on the empty string a pooled-connection GUC reset produces, turning
-- a data leak into an intermittent 500. current_setting(..., true) returns
-- NULL when app.tenant_id was never set at all, so NULLIF(NULL, '') stays
-- NULL and the comparison correctly matches zero rows instead of throwing.

DROP VIEW v_unit_stage_status;

CREATE VIEW v_unit_stage_status
WITH (security_invoker = true) AS
WITH exploded AS (
  SELECT
    e.job_id,
    u.id      AS unit_id,
    s.stage_no,
    pp.id     AS plan_id,
    jp.seq    AS jp_seq,
    jp.code   AS jp_code,
    pp.status AS status,
    (pp.status IS NOT NULL
       AND pp.status <> 'COMPLETE'
       AND pp.planned_finish IS NOT NULL
       AND pp.planned_finish < (now() AT TIME ZONE 'UTC')) AS is_overdue,
    EXISTS (
      SELECT 1
      FROM qcp_item_processes qip
      JOIN qcp_executions qe
        ON qe.qcp_item_id = qip.qcp_item_id
       AND qe.unit_id = u.id
      WHERE qip.job_process_id = jp.id
        AND qe.result = 'REJECTED'
    ) AS is_rejected
  FROM units u
  JOIN equipments e    ON e.id = u.equipment_id
  JOIN jobs j          ON j.id = e.job_id AND j.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
  JOIN job_processes jp ON jp.job_id = e.job_id
  CROSS JOIN LATERAL unnest(jp.work_order_stages) AS s(stage_no)
  LEFT JOIN schedule_runs sr
    ON sr.job_id = e.job_id AND sr.is_current = true
  LEFT JOIN process_plans pp
    ON pp.job_process_id = jp.id
   AND pp.unit_id = u.id
   AND pp.schedule_run_id = sr.id
),
-- §11.3: earliest not-complete backing plan wins; if all complete, the last one.
governing AS (
  SELECT DISTINCT ON (unit_id, stage_no)
    unit_id, stage_no, plan_id
  FROM exploded
  ORDER BY
    unit_id, stage_no,
    (CASE WHEN status IS DISTINCT FROM 'COMPLETE' THEN 0 ELSE 1 END),
    (CASE WHEN status IS DISTINCT FROM 'COMPLETE' THEN jp_seq ELSE -jp_seq END),
    jp_code
)
SELECT
  x.job_id,
  x.unit_id,
  x.stage_no,
  CASE
    WHEN count(*) FILTER (WHERE x.status IS NOT NULL) > 0
         AND count(*) FILTER (WHERE x.status IS DISTINCT FROM 'COMPLETE') = 0
      THEN 'complete'
    WHEN bool_or(x.status = 'ON_HOLD')                       THEN 'hold'
    WHEN bool_or(x.is_overdue)                               THEN 'overdue'
    WHEN bool_or(x.status = 'SUBMITTED')                     THEN 'submitted'
    WHEN bool_or(x.status = 'IN_PROGRESS')
      OR bool_or(x.status = 'COMPLETE')                      THEN 'progress'
    ELSE 'idle'
  END AS fill_status,
  bool_or(x.is_overdue)  AS is_overdue,
  bool_or(x.is_rejected) AS is_rejected,
  g.plan_id AS governing_plan_id
FROM exploded x
JOIN governing g ON g.unit_id = x.unit_id AND g.stage_no = x.stage_no
GROUP BY x.job_id, x.unit_id, x.stage_no, g.plan_id;

GRANT SELECT ON v_unit_stage_status TO despl_web;

DROP VIEW v_process_plan_percent;

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
JOIN jobs j ON j.id = jp.job_id AND j.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
CROSS JOIN LATERAL (
  SELECT CASE WHEN pp.unit_id IS NOT NULL AND jp.code ~ '^[0-9]+$' THEN jp.code::int END AS lt_seq
) seq
CROSS JOIN LATERAL (
  SELECT
    COALESCE((
      SELECT count(*) FROM component_operations co
      JOIN components c ON c.id = co.component_id
      JOIN operation_ref_family_seqs orfs ON orfs.operation_ref_id = co.operation_id AND orfs.family_id = j.family_id
      WHERE c.unit_id = pp.unit_id AND orfs.lead_time_process_seq = seq.lt_seq
    ), 0)
    + COALESCE((
      SELECT count(*) FROM assembly_steps asm
      JOIN assembly_template_steps ats ON ats.id = asm.template_step_id
      WHERE asm.unit_id = pp.unit_id AND ats.lead_time_process_seq = seq.lt_seq
    ), 0) AS total,
    COALESCE((
      SELECT count(*) FROM component_operations co
      JOIN components c ON c.id = co.component_id
      JOIN operation_ref_family_seqs orfs ON orfs.operation_ref_id = co.operation_id AND orfs.family_id = j.family_id
      WHERE c.unit_id = pp.unit_id AND orfs.lead_time_process_seq = seq.lt_seq AND co.status = 'COMPLETE'
    ), 0)
    + COALESCE((
      SELECT count(*) FROM assembly_steps asm
      JOIN assembly_template_steps ats ON ats.id = asm.template_step_id
      WHERE asm.unit_id = pp.unit_id AND ats.lead_time_process_seq = seq.lt_seq AND asm.status = 'COMPLETE'
    ), 0) AS complete
) mapped;

GRANT SELECT ON v_process_plan_percent TO despl_web;
