-- AUD-080 — step 5 of 5: auto-derive tenant_id, same follow-up AUD-001 did
-- (20260909130000_aud001_tenant_id_autofill_trigger).
--
-- Reuses aud001_derive_tenant_id as-is (not redefined here) — it is already
-- fully generic (`SELECT tenant_id INTO NEW.tenant_id FROM jobs WHERE id =
-- NEW.job_id` when job_id is not null), so wiring it onto these nine tables'
-- BEFORE INSERT trigger needs no new function, just a new trigger per table.
--
-- schema.prisma marks the eight strict tables' tenantId with @default(0) so
-- Prisma treats the field as optional in create() input; qcp_templates has
-- no default (nullable, library rows genuinely have no tenant) — same shape
-- AUD-001 used for qcp_items/inspection_parties/qcp_item_party_codes.

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
    EXECUTE format('DROP TRIGGER IF EXISTS aud080_tenant_id_autofill ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER aud080_tenant_id_autofill BEFORE INSERT ON %I
         FOR EACH ROW EXECUTE FUNCTION aud001_derive_tenant_id()',
      t
    );
  END LOOP;
END
$$;

ALTER TABLE "equipments" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "packages" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "job_processes" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "schedule_runs" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "weld_joints" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "weld_logs" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "assembly_drawings" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "dispatch_batches" ALTER COLUMN "tenant_id" SET DEFAULT 0;
-- qcp_templates: no DEFAULT — nullable, library rows correctly stay NULL.
