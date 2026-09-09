-- AUD-001 — tenant-grain RLS backstop, follow-up: auto-derive tenant_id.
--
-- Making tenant_id NOT NULL surfaced a real app-layer gap: nothing currently
-- sets it. Every Prisma `create()` call across lib/services/ for these 28
-- tables would need tenantId added by hand (`pnpm typecheck` confirms this —
-- dozens of call sites fail with "Property 'tenantId' is missing"). Editing
-- every one of those by hand, in the same PR that adds the RLS floor, is
-- exactly the kind of large, easy-to-miss-one-caller change this session's
-- own brief warns against ("a wrong join backfills the wrong tenant onto
-- real rows" — the INSERT-time equivalent is a missed caller writing tenant_id
-- wrong, or not at all, and RLS then silently hiding the row from everyone
-- including its own owner).
--
-- Fix at the same layer as the rest of this session: the database. A BEFORE
-- INSERT trigger derives tenant_id from job_id (the same direct, FK-backed
-- join step 2 uses) and overwrites whatever was supplied — including a
-- client-supplied wrong value — before any constraint is checked. This is
-- strictly more defensive than trusting the app layer to set it right, and
-- it means no caller anywhere (service code, seed scripts, future code) can
-- forget to set tenant_id: the DB always sets the true value when job_id is
-- present, full stop.
--
-- schema.prisma marks the 25 NOT-NULL tables' tenantId with @default(0) so
-- Prisma treats the field as optional in create() input and omits it from
-- the generated INSERT — Postgres's own column DEFAULT 0 (added below) is
-- what actually applies when the field is omitted, and the trigger
-- overwrites that placeholder before NOT NULL/FK are checked. organizations.id
-- is an autoincrement PK starting at 1, so literal 0 can never be a real
-- tenant and is never actually persisted (verified live — see PR description).
--
-- The 3 library-exempt tables (qcp_items, inspection_parties,
-- qcp_item_party_codes) get the trigger too, but no default: job_id is
-- genuinely nullable there, and when it's null there is no job to derive a
-- tenant from, so tenant_id correctly stays whatever was supplied (normally
-- null, mirroring job_id).

CREATE OR REPLACE FUNCTION aud001_derive_tenant_id() RETURNS trigger AS $$
BEGIN
  IF NEW.job_id IS NOT NULL THEN
    SELECT tenant_id INTO NEW.tenant_id FROM jobs WHERE id = NEW.job_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
  job_tables text[] := ARRAY[
    'units', 'bom_revisions', 'bom_items', 'components',
    'job_process_edges', 'process_plans', 'weld_joint_welders',
    'ndt_results', 'drawing_revisions', 'dispatch_batch_units',
    'inspection_parties', 'qcp_items', 'component_operations',
    'component_operation_rejections', 'paint_records', 'dft_readings',
    'assembly_steps', 'assembly_step_rejections', 'ncrs',
    'qcp_executions', 'qcp_item_processes', 'qcp_item_party_codes',
    'delay_reasons', 'stock_lots', 'stock_txns', 'procurement_events',
    'material_identifications', 'item_tests'
  ];
BEGIN
  FOREACH t IN ARRAY job_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS aud001_tenant_id_autofill ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER aud001_tenant_id_autofill BEFORE INSERT ON %I
         FOR EACH ROW EXECUTE FUNCTION aud001_derive_tenant_id()',
      t
    );
  END LOOP;
END
$$;

ALTER TABLE "units" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "bom_revisions" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "bom_items" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "components" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "job_process_edges" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "process_plans" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "weld_joint_welders" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "ndt_results" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "drawing_revisions" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "dispatch_batch_units" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "component_operations" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "component_operation_rejections" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "paint_records" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "dft_readings" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "assembly_steps" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "assembly_step_rejections" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "ncrs" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "qcp_executions" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "qcp_item_processes" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "delay_reasons" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "stock_lots" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "stock_txns" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "procurement_events" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "material_identifications" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "item_tests" ALTER COLUMN "tenant_id" SET DEFAULT 0;
