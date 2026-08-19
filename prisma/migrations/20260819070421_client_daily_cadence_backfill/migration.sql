-- Client id 1 is DESPL's real client (owns DE0463/DE0467/DESPL-320).
-- DESPL-320 is the pilot job for daily client-portal updates
-- (2026-08-19 spec) — moves this client off the seeded WEEKLY default.
-- Any other client rows in this database are leaked DB-gated-test
-- fixtures (see progress.md "Blockers"), never real, and are untouched.
UPDATE "client_visibility_policies" SET "cadence" = 'DAILY' WHERE "client_id" = 1;
