-- AUD-021 (perf): v_unit_stage_status read `exploded` twice (once for the status rollup, once to find the
-- governing plan), so PostgreSQL materialised it as a CTE: an optimisation fence (the caller's
-- `WHERE job_id = ...` never reached the base tables) and the two reads were joined by a nested loop over
-- the whole tenant (O(rows^2); ~27 s for one job on a 93-unit dataset under RLS). Now a single pass: the
-- governing plan is the first plan_id in the same §11.3 order (earliest not-complete wins, else the last
-- one), taken with array_agg(... ORDER BY ...)[1] instead of a DISTINCT ON self-join, and `exploded` is an
-- inlined subquery so job_id is pushed down. Row set, column list, types and values are unchanged
-- (pinned by the equal-results DB test). CREATE OR REPLACE keeps GRANTs and security_invoker; no data is
-- touched. Body otherwise identical to 20261024100000_j3b_line_stage_view.

CREATE OR REPLACE VIEW v_unit_stage_status
WITH (security_invoker = true) AS
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
  -- §11.3: earliest not-complete backing plan wins; if all complete, the last one.
  (array_agg(
     x.plan_id
     ORDER BY
       (CASE WHEN x.status IS DISTINCT FROM 'COMPLETE' THEN 0 ELSE 1 END),
       (CASE WHEN x.status IS DISTINCT FROM 'COMPLETE' THEN x.jp_seq ELSE -x.jp_seq END),
       x.jp_code
   ))[1] AS governing_plan_id
FROM (
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
) x
GROUP BY x.job_id, x.unit_id, x.stage_no;
