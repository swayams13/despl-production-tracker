-- v_unit_stage_status — the canonical 36-process → 25-stage rollup (DESIGN_SPEC §11.5).
-- One row per (unit, stage). `fill_status` implements the §11.2 first-match-wins
-- ladder; `is_overdue`/`is_rejected` are the secondary-marker booleans (rendered
-- as pips only when true and not already the fill). `governing_plan_id` is the
-- earliest-by-seq not-yet-complete backing plan (§11.3), used to route actions.
--
-- security_invoker = true so the underlying tables' tenant RLS is evaluated as
-- the *querying* role (despl_web), not the view owner — without it a superuser
-- owner would bypass RLS and leak cross-tenant rows.
--
-- Overdue uses `now() AT TIME ZONE 'UTC'` to compare against the UTC timestamps
-- Prisma stores, matching the JS `plannedFinish < new Date()` used elsewhere.
--
-- ponytail: rolls up plans matched to the unit (pp.unit_id = u.id). The PV pilot
-- schedules per-unit so every plan has a unit. Equipment-grain plans (unit_id
-- NULL, BUILD-SPEC §0 #2) are NOT yet fanned across the equipment's units — add
-- an `OR pp.unit_id IS NULL` branch here when a job first schedules at that grain.

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
