-- AUD-030 — v_unit_stage_status's `exploded` CTE joins job_processes with no
-- `included` predicate, so a legitimately excluded JobProcess (included =
-- false — this client's spec skips it, e.g. no PWHT required; a real,
-- allowed exclusion, distinct from AUD-033's separate finding about whether
-- an exclusion should have been *allowed* at intake) still gets its
-- work_order_stages unnested into the per-unit rollup. schedule.service.ts's
-- generateSchedule (`included = spine.processes.filter((p) => p.included
-- !== false)`, line ~55) never creates a ProcessPlan for an excluded
-- JobProcess, so the LEFT JOIN process_plans below already returns NULL for
-- it — that part of the design is sound. The bug is downstream, in the
-- final GROUP BY x.stage_no aggregation:
--
--   - A stage_no touched ONLY by an excluded JobProcess (no other JobProcess
--     shares it): every x row has status = NULL, so `count(*) FILTER (WHERE
--     status IS NOT NULL) > 0` is false, no other WHEN branch fires (is_overdue
--     is false, no status equals any tracked value), so it falls to ELSE and
--     renders 'idle' forever — a phantom grey stage tile for a stage that was
--     deliberately removed from this job's scope.
--   - A stage_no shared with an included JobProcess (both processes' declared
--     work_order_stages happen to include the same stage number) is worse:
--     `count(*) FILTER (WHERE status IS DISTINCT FROM 'COMPLETE') = 0` uses
--     IS DISTINCT FROM, which — unlike `=` — treats NULL as distinct from
--     'COMPLETE'. So the excluded process's NULL-status row keeps that count
--     above zero even once every *included* process at that stage is
--     COMPLETE, permanently blocking the 'complete' branch. The stage instead
--     falls through to 'progress' (since the included process's status is
--     COMPLETE, which the `bool_or(status = 'IN_PROGRESS' OR status =
--     'COMPLETE')` branch catches) and never flips to 'complete', no matter
--     how long the job runs. This is the "excludes a process → its stages
--     stay non-complete forever" defect named in
--     audit/19_MASTER_ISSUE_REGISTER.md's AUD-030 row and referenced from
--     07_PROJECT_AUDIT.md §9's AUD-033 note ("some spine stages sit grey
--     forever ... reads as 'not started', not 'deleted from this job'").
--
-- v_process_plan_percent is NOT touched by this migration: every job_processes
-- reference in its body (`JOIN job_processes jp ON jp.id = pp.job_process_id`)
-- is reached exclusively through process_plans, which — per the same
-- generateSchedule invariant above — never has a row for an excluded
-- JobProcess in the first place. That view's percent-complete numerator and
-- denominator (component_operations/assembly_steps mapped by
-- lead_time_process_seq) already exclude excluded processes correctly; there
-- is nothing to fix there.
--
-- Fix: add `AND jp.included = true` to the exploded CTE's join to
-- job_processes, so an excluded JobProcess's work_order_stages never enter
-- the rollup at all — for a job with zero exclusions (the overwhelming
-- majority case, `included` defaulting true), this predicate is always true
-- and the result set is byte-for-byte identical to before.
--
-- Built on top of 20260908130000_ist_day_marker_overdue_fix (AUD-027), the
-- newest migration touching v_unit_stage_status's body — confirmed via
-- `ls prisma/migrations | tail` and `grep -rln v_unit_stage_status
-- prisma/migrations`; 20260908130000_schedule_run_one_current_per_job (the
-- other migration sharing that timestamp) only adds an index on
-- schedule_runs and does not reference either view. Reproduces that
-- migration's entire v_unit_stage_status body verbatim — same tenant join
-- (AUD-002), same ist_day_marker() overdue predicate (AUD-027), same
-- governing-plan tie-break comment (§11.3) — with only the one predicate
-- added below. CREATE OR REPLACE VIEW (not DROP + CREATE) per this session's
-- own constraint, which has the useful side effect of preserving the view's
-- existing GRANT to despl_app without having to reissue it.

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
