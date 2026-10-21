-- Lean Core J3b (line-aware reads): v_unit_stage_status joined every unit to EVERY included
-- job_processes row of its job, so a unit on a line with its own route also got the job-level
-- UNIT-grain rows (no plan for it) and its stages could never read complete. Now a unit sees only
-- its route's rows: its line's own rows, plus the job-level rows when the line runs the job's own
-- route (or is unpinned), plus the JOB-grain rows always. Body identical to
-- 20261023100000_l13_job_grain_stage_view except the one extra join condition; for a job with no
-- line-scoped rows (all of production today) the condition is true for every row. CREATE OR REPLACE
-- keeps the GRANT and security_invoker; the column list is unchanged. No data is touched.

CREATE OR REPLACE VIEW v_unit_stage_status
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
       AND pp.planned_finish < ist_day_marker(now())) AS is_overdue,
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
  JOIN job_processes jp ON jp.job_id = e.job_id AND jp.included = true
   -- Lean Core J3b: only the processes of this unit's route (SQL twin of inRoute/routeKey in line-route.ts).
   AND (jp.equipment_id = e.id
        OR (jp.equipment_id IS NULL
            AND (jp.grain = 'JOB' OR e.template_version_id IS NULL OR e.template_version_id = j.template_version_id)))
  CROSS JOIN LATERAL unnest(jp.work_order_stages) AS s(stage_no)
  LEFT JOIN schedule_runs sr
    ON sr.job_id = e.job_id AND sr.is_current = true
  LEFT JOIN process_plans pp
    ON pp.job_process_id = jp.id
   AND pp.schedule_run_id = sr.id
   AND (
        pp.unit_id = u.id
        -- Lean Core L1.3: a JOB-grain process has ONE unit-less plan, shown on every unit; a unit's own plan wins.
        OR (pp.unit_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM process_plans own
              WHERE own.job_process_id = jp.id AND own.schedule_run_id = sr.id AND own.unit_id = u.id
            ))
       )
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
