-- AUD-078 — step 2 of 3: NOT NULL, now that every row has a real owner.
-- DEFAULT 0 too, matching schema.prisma's `@default(0)` placeholder shape —
-- the value the app never actually relies on for job-owned rows (the
-- aud001_derive_tenant_id trigger overwrites it before any constraint
-- check runs) but which Prisma needs present so `.create()` can still omit
-- tenantId on those rows; only library-authoring writes (jobId null) must
-- now supply a real one explicitly, since the trigger doesn't touch them.

ALTER TABLE "qcp_templates" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "qcp_templates" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "qcp_items" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "qcp_items" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "inspection_parties" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "inspection_parties" ALTER COLUMN "tenant_id" SET DEFAULT 0;
ALTER TABLE "qcp_item_party_codes" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "qcp_item_party_codes" ALTER COLUMN "tenant_id" SET DEFAULT 0;
