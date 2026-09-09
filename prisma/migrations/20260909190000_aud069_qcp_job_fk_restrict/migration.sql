-- AUD-069 — the four SET NULL FKs off jobs that silently promote a deleted
-- job's QCP rows into the shared, cross-tenant-readable library.
--
-- audit/11_DATABASE_AUDIT.md §5.3: job_id IS NULL means "library template" by
-- design (20260905030000_qcp_item_library_process_codes) — so deleting a job
-- doesn't remove its QCP rows, it silently promotes them into the shared
-- library, where job_isolation's fail-open `job_id IS NULL` branch (and, for
-- qcp_templates specifically until this same session's AUD-080 migrations,
-- no RLS at all) makes them readable by every tenant. Customer-specific
-- inspection extents, acceptance criteria and TPI party codes are
-- commercially sensitive and often contractually confidential.
--
-- Reachability check before this session treated the FK change as safe,
-- low-risk hardening: `grep -rn "jobService.deleteJob\|prisma.job.delete\|
-- tx.job.delete" src/` matches only test-file-local helper functions named
-- `deleteJobAndChildren` in *.test.ts cleanup code (owner-role Prisma client,
-- bypasses RLS/FKs by nature of being the table owner in a throwaway
-- fixture) — never a real service export or Server Action. `grep -n
-- "^export" src/lib/services/job-intake.service.ts` confirms no `deleteJob`
-- export exists at all. Job deletion is not a real, UI-reachable path in
-- this codebase today, so RESTRICT is a behavior change with no user-facing
-- effect — it only changes what happens on a delete path that doesn't exist
-- yet. If a real delete-job flow is ever built, it will need to handle these
-- four relations explicitly (fail naming the blocking QCP rows, or an
-- explicit, audited "convert to library template" step) before it can ever
-- delete a job with QCP rows attached.

ALTER TABLE "qcp_templates" DROP CONSTRAINT "qcp_templates_job_id_fkey";
ALTER TABLE "qcp_templates" ADD CONSTRAINT "qcp_templates_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "qcp_items" DROP CONSTRAINT "qcp_items_job_id_fkey";
ALTER TABLE "qcp_items" ADD CONSTRAINT "qcp_items_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "inspection_parties" DROP CONSTRAINT "inspection_parties_job_id_fkey";
ALTER TABLE "inspection_parties" ADD CONSTRAINT "inspection_parties_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "qcp_item_party_codes" DROP CONSTRAINT "qcp_item_party_codes_job_id_fkey";
ALTER TABLE "qcp_item_party_codes" ADD CONSTRAINT "qcp_item_party_codes_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
