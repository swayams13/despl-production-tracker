-- AUD-027 — two incompatible definitions of "overdue". The TS side
-- (src/lib/shared/business-day.ts's istCalendarDayMarker/isOverdue/isOnTime)
-- already fixed the bug: a raw `plannedFinish < now()` flips a plan overdue
-- at 00:00 UTC = 05:30 IST on its own due date, a full working day early.
-- That fix was never applied to the raw SQL that computes the same
-- overdue-ness directly in the database. This migration gives SQL one
-- source of truth for "which IST calendar day is this instant in" and
-- repoints v_unit_stage_status.is_overdue at it. jobs.read.ts's tallies
-- query and portfolio.read.ts's newly_overdue sub-select are app code, not
-- migrations, and are updated in the same commit as this file.
--
-- ist_day_marker mirrors istCalendarDayMarker exactly: it returns the
-- UTC-midnight marker of the IST calendar date `ts` falls in — NOT the
-- actual IST-midnight instant. That distinction matters because
-- plannedFinish/committedDeliveryDate etc. are themselves stored as
-- UTC-midnight markers of a calendar day (lib/schedule/calendar.ts's
-- toDateOnly), so the two sides of any `<`/`<=` comparison must be encoded
-- the same way to be comparable at all.
--
-- A naive `date_trunc('day', ts AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE
-- 'Asia/Kolkata'` (the first draft of this function) computes something
-- different — the real IST-midnight instant, 5.5 hours earlier than the
-- UTC-midnight marker istCalendarDayMarker returns — and was rejected after
-- checking both forms against istCalendarDayMarker's own test cases
-- (05:29/18:29/18:30 UTC Aug 25, 00:00 UTC Aug 26 — see
-- src/lib/shared/business-day.test.ts). The expression below was verified
-- to reproduce all four of those exactly (SET TIME ZONE 'UTC' in the
-- session to rule out a session-TimeZone dependency, since the function
-- must be IMMUTABLE-safe: every AT TIME ZONE conversion here uses the
-- literal 'UTC', never the session default).
CREATE OR REPLACE FUNCTION ist_day_marker(ts timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date_trunc('day', (ts AT TIME ZONE 'UTC') + interval '5 hours 30 minutes') AT TIME ZONE 'UTC';
$$;

-- v_unit_stage_status: starts from 20260908100000_tenant_scoped_status_views'
-- body (AUD-002's tenant join — already on main when this was written, per
-- git log). Only the is_overdue predicate changes; nothing else moves.
-- DROP+CREATE loses the view's prior grants, so one is reissued below — but
-- only to despl_app, not despl_web directly (per AUD-100's fix, a bare
-- `GRANT ... TO despl_web` fails a from-scratch replay because despl_web
-- isn't created by the migration set at all; despl_web inherits SELECT via
-- its membership in despl_app instead, granted once despl_web exists by
-- scripts/provision-db-role.sql). Granting despl_web directly again here
-- would silently reintroduce the exact bug AUD-100 closed.
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

GRANT SELECT ON v_unit_stage_status TO despl_app;
