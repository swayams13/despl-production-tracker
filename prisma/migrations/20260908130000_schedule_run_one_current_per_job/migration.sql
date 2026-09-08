-- AUD-034 — a job could hold two `is_current` ScheduleRun rows at once.
--
-- `persistScheduleRun` (src/lib/services/_shared.ts) demoted prior current
-- runs scoped to (job_id, equipment_id). `generateSchedule` and
-- `applyDurationOverride` both accept an optional equipmentId; a job-grain
-- call (equipmentId NULL) followed by an equipment-grain call (equipmentId
-- set) left BOTH rows is_current = true for the same job — proven live.
-- Every reader that assumes exactly one current run per job then double-
-- counts (v_unit_stage_status's exploded CTE fans out across both;
-- jobs.read.ts/portfolio.read.ts double totalPlans/completePlans/
-- overduePlans), and getCurrentScheduleRun's `equipmentId ?? null` default
-- silently misses the equipment-grain run for nearly every caller.
--
-- No real UI path exercises per-equipment scheduling today (job-intake's
-- scheduleNewJobAction never passes equipmentId; override.service.ts's
-- schema accepts one but has no caller that supplies it) — the stronger,
-- simpler invariant is enforced instead of a partial unique index scoped to
-- COALESCE(equipment_id, -1), which would only stop two runs at the
-- *identical* grain from racing and would do nothing for this job-grain-vs-
-- equipment-grain case.
--
-- Preflight (read-only) run against despl_test before writing this file:
-- zero jobs had more than one is_current row (1350 current rows, 1350
-- distinct job_id). The UPDATE below is kept anyway as a safety net — a
-- no-op today, but the constraint below is what actually closes the bug for
-- any job that reaches this state before this migration is applied
-- elsewhere (e.g. production, not rehearsed here — see
-- docs/mos-execution/MERGE-RUNBOOK.md before applying there).

WITH ranked AS (
  SELECT id, job_id,
         row_number() OVER (PARTITION BY job_id ORDER BY created_at DESC, id DESC) AS rn
  FROM schedule_runs
  WHERE is_current = true
)
UPDATE schedule_runs SET is_current = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- One current row per job, full stop, regardless of equipment_id grain.
CREATE UNIQUE INDEX schedule_runs_one_current_per_job ON schedule_runs (job_id) WHERE is_current;
