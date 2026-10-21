-- Lean Core J8 (D9): company-wide milestones and the per-family process -> milestone map.
-- Two new tenant-root tables, no backfill, no change to any existing table.
-- The map is keyed by process CODE so it survives template versions.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "milestones" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "milestone_process_maps" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "process_code" TEXT NOT NULL,
    "milestone_id" INTEGER NOT NULL,
    "weight" DECIMAL(8,2),

    CONSTRAINT "milestone_process_maps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "milestones_tenant_id_code_key" ON "milestones"("tenant_id", "code");
CREATE INDEX "milestones_tenant_id_idx" ON "milestones"("tenant_id");
CREATE UNIQUE INDEX "milestone_process_maps_family_id_process_code_key" ON "milestone_process_maps"("family_id", "process_code");
CREATE INDEX "milestone_process_maps_tenant_id_idx" ON "milestone_process_maps"("tenant_id");
CREATE INDEX "milestone_process_maps_milestone_id_idx" ON "milestone_process_maps"("milestone_id");

ALTER TABLE "milestones" ADD CONSTRAINT "milestones_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "milestone_process_maps" ADD CONSTRAINT "milestone_process_maps_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "milestone_process_maps" ADD CONSTRAINT "milestone_process_maps_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "milestone_process_maps" ADD CONSTRAINT "milestone_process_maps_milestone_id_fkey"
  FOREIGN KEY ("milestone_id") REFERENCES "milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "milestone_process_maps" ADD CONSTRAINT "milestone_process_maps_weight_chk" CHECK ("weight" IS NULL OR "weight" > 0);

ALTER TABLE "milestones" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "milestones"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);

ALTER TABLE "milestone_process_maps" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "milestone_process_maps"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);
