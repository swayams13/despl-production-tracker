-- Fix wave, Phase 4 (Important #3): `procurement_events`, `stock_lots` and
-- `stock_txns` are all append-only ledgers by design (the same convention
-- `audit_log`/`domain_events` already follow, revoked in migration
-- 20260813051500_rls_and_app_role) — no `update`/`delete` call exists
-- anywhere in `src/` for any of the three, and the B5/B6 plan items
-- explicitly require it for ProcurementEvent ("the app DB role gets no
-- UPDATE/DELETE grant on this table"). That revoke was never added for any
-- of the three when the tables were created — this migration closes the gap.
REVOKE UPDATE, DELETE ON "procurement_events" FROM despl_app;
REVOKE UPDATE, DELETE ON "stock_lots" FROM despl_app;
REVOKE UPDATE, DELETE ON "stock_txns" FROM despl_app;
