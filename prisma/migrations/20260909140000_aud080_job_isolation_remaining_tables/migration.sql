-- AUD-080 — the nine job_id-carrying tables H1/AUD-001 omitted, step 1 of 5:
-- job_isolation.
--
-- audit/12_SECURITY_RBAC.md §1: these nine tables carry job_id and were
-- eligible for H1's backstop but were left out of its table array, because
-- that array was hand-derived from "tables this migration is adding a
-- column to" rather than "tables that have the column". No RLS at all is
-- currently enabled on any of them (audit/11_DATABASE_AUDIT.md §3.1) —
-- unlike the AUD-001 batch, which already had job_isolation and only needed
-- the tenant floor added on top, these nine need both halves from scratch.
--
-- Scope: assembly_drawings, dispatch_batches, equipments, job_processes,
-- packages, qcp_templates, schedule_runs, weld_joints, weld_logs.
-- qcp_templates was checked against the live schema per this session's own
-- instruction rather than trusted from the dispatch note claiming Session 15
-- already covers it: schema.prisma has no tenantId column on QcpTemplate,
-- the qcp_templates_job_id_fkey is still ON DELETE SET NULL (init migration,
-- line 1257), and rls-coverage.test.ts's own KNOWN_UNPROTECTED_JOB_TABLES
-- allowlist (still present on this branch) lists qcp_templates as one of the
-- nine. AUD-077 (the job-match check in recordQcpExecution) landed via PR
-- #57; AUD-078 (the broader product question — should a genuinely global,
-- cross-tenant library template be visible to every tenant, and does that
-- need its own decision beyond "give it the same RLS shape as its sibling
-- library rows") is still open per audit/19_MASTER_ISSUE_REGISTER.md
-- ("BLOCKED ON PRODUCT DECISION"). This migration does not resolve AUD-078 —
-- it gives qcp_templates the exact same nullable-tenant, fail-open-for-null
-- RLS shape already shipped for qcp_items/inspection_parties/
-- qcp_item_party_codes (the three sibling "library row" tables from H1/
-- AUD-001), which is a mechanical application of an already-approved
-- pattern, not a new design decision.
--
-- job_isolation copied verbatim from 20260905091500_h1_job_isolation_rls_
-- nullif_fix (the NULLIF-safe version — the original 20260905090000 version
-- had a pooled-connection empty-string cast bug, fixed there; no reason to
-- reintroduce it here).
DO $$
DECLARE
  t text;
  job_tables text[] := ARRAY[
    'equipments', 'packages', 'job_processes', 'schedule_runs',
    'weld_joints', 'weld_logs', 'assembly_drawings', 'dispatch_batches',
    'qcp_templates'
  ];
BEGIN
  FOREACH t IN ARRAY job_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS job_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY job_isolation ON %I
        USING (
          job_id IS NULL
          OR NULLIF(current_setting('app.job_id', true), '') IS NULL
          OR job_id = NULLIF(current_setting('app.job_id', true), '')::int
        )
        WITH CHECK (
          job_id IS NULL
          OR NULLIF(current_setting('app.job_id', true), '') IS NULL
          OR job_id = NULLIF(current_setting('app.job_id', true), '')::int
        )
    $f$, t);
  END LOOP;
END
$$;
