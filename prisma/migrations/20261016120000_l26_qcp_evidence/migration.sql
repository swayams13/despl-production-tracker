-- Lean Core L2.6 — evidence on a QCP execution (build prompt §8.2 item 18).
-- QC accepting a hold or witness point on a third party's behalf records who
-- the inspector was (qcp_executions.cleared_by_party_ref, which already
-- exists and had no writer) and the report / IRN number; a hydro test also
-- records test pressure, hold time and gauge ids. Additive, nullable, no
-- backfill, no grant or RLS change (new columns on an existing table).
--
--   * report_ref  the third party's report / IRN / inspection-call number
--   * test_data   { pressureBar, holdMinutes, gaugeIds[] } for a test point

SET LOCAL lock_timeout = '5s';

ALTER TABLE "qcp_executions"
  ADD COLUMN "report_ref" TEXT,
  ADD COLUMN "test_data" JSONB;
