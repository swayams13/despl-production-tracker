-- AUD-078 — step 1 of 3: close the "genuinely shared" fail-open exception
-- AUD-080 left on qcp_templates/qcp_items/inspection_parties/
-- qcp_item_party_codes, now that the product decision is made: QCP library
-- content is private per tenant, not a shared cross-tenant catalog.
--
-- Every one of the 4 tables' remaining tenant_id IS NULL rows is a genuine
-- library row (job_id IS NULL) — AUD-080's backfill already covered every
-- job-owned row via job_id -> jobs.tenant_id. There is no job to derive a
-- tenant from here, so backfill from audit_log instead: recordAudit
-- (src/lib/audit/index.ts) always writes audit_log.tenant_id = actor.tenantId
-- in the same transaction as the create, so the row that created a library
-- QcpTemplate names its true owning tenant directly.
--
-- qcp_items / inspection_parties / qcp_item_party_codes never carried their
-- own "created this row" audit entry (addQcpItemToLibraryTemplate audits
-- the QcpItem create, not the InspectionParty/QcpItemPartyCode rows nested
-- under it) — backfill those from their now-backfilled parent instead:
-- qcp_items and inspection_parties both reference qcp_template_id directly;
-- qcp_item_party_codes has no direct FK to qcp_templates, so it goes via
-- qcp_item_id -> qcp_items.qcp_template_id.

UPDATE "qcp_templates" t
SET tenant_id = al.tenant_id
FROM "audit_log" al
WHERE al.entity_type = 'QcpTemplate'
  AND al.entity_id = t.id::text
  AND al.action = 'qcp.template.createLibrary'
  AND t.tenant_id IS NULL
  AND t.job_id IS NULL;

-- Fallback for rows with no audit_log trail: prisma/seed.ts's
-- seedQcpTemplate wrote the original 3 library templates (Ammonia
-- Vaporizer, the BUSCI/TPI+EIL/TPIA Vessel QAP, PIPE-SPOOL-STD) directly via
-- tx.qcpTemplate.create — the real app write path, but never through
-- createQcpTemplateLibrary/audited(), so no audit_log row exists to
-- backfill from. These are DESPL's own authored library content from
-- before multi-tenancy existed; the org they belong to is identifiable by
-- its well-known seed code, not a guess (organizations.code = 'DESPL' is a
-- unique idempotency sentinel — see prisma/seed.ts's own "Tenant
-- (idempotency sentinel)" step).
UPDATE "qcp_templates" t
SET tenant_id = o.id
FROM "organizations" o
WHERE o.code = 'DESPL'
  AND t.tenant_id IS NULL
  AND t.job_id IS NULL;

UPDATE "qcp_items" i
SET tenant_id = qt.tenant_id
FROM "qcp_templates" qt
WHERE qt.id = i.qcp_template_id
  AND i.tenant_id IS NULL
  AND i.job_id IS NULL;

UPDATE "inspection_parties" p
SET tenant_id = qt.tenant_id
FROM "qcp_templates" qt
WHERE qt.id = p.qcp_template_id
  AND p.tenant_id IS NULL
  AND p.job_id IS NULL;

UPDATE "qcp_item_party_codes" c
SET tenant_id = i.tenant_id
FROM "qcp_items" i
WHERE i.id = c.qcp_item_id
  AND c.tenant_id IS NULL
  AND c.job_id IS NULL;

-- PREFLIGHT: any row still NULL after this means either a library row whose
-- creating audit_log entry is missing (shouldn't happen — createQcpTemplateLibrary
-- always calls audited()) or a job-owned row AUD-080's backfill should
-- already have covered (also shouldn't happen). Raise loudly rather than
-- let the NOT NULL constraint in the next migration fail with a less
-- specific error.
DO $$
DECLARE
  t text;
  orphan_count bigint;
  tables text[] := ARRAY[
    'qcp_templates', 'qcp_items', 'inspection_parties', 'qcp_item_party_codes'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id IS NULL', t) INTO orphan_count;
    IF orphan_count > 0 THEN
      RAISE EXCEPTION 'AUD-078 preflight failed: % has % row(s) with tenant_id IS NULL after backfill', t, orphan_count;
    END IF;
  END LOOP;
END
$$;
