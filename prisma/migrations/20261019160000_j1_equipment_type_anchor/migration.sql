-- Lean Core J1: equipment type is the assembly-template anchor.
-- Additive and forward-only: one nullable column, one new empty table. No row
-- is touched; every existing template stays the family-level fallback (NULL).

ALTER TABLE "assembly_templates" ADD COLUMN "equipment_type_id" INTEGER;

CREATE UNIQUE INDEX "assembly_templates_equipment_type_id_key" ON "assembly_templates"("equipment_type_id");

ALTER TABLE "assembly_templates"
  ADD CONSTRAINT "assembly_templates_equipment_type_id_fkey"
  FOREIGN KEY ("equipment_type_id") REFERENCES "equipment_type_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "equipment_type_components" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "equipment_type_id" INTEGER NOT NULL,
    "component_type_id" INTEGER NOT NULL,
    "default_qty" INTEGER NOT NULL DEFAULT 1,
    "qty_source" TEXT NOT NULL DEFAULT 'FIXED',

    CONSTRAINT "equipment_type_components_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "equipment_type_components_equipment_type_id_component_type_id_key"
  ON "equipment_type_components"("equipment_type_id", "component_type_id");
CREATE INDEX "equipment_type_components_tenant_id_idx" ON "equipment_type_components"("tenant_id");
CREATE INDEX "equipment_type_components_component_type_id_idx" ON "equipment_type_components"("component_type_id");

ALTER TABLE "equipment_type_components"
  ADD CONSTRAINT "equipment_type_components_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "equipment_type_components"
  ADD CONSTRAINT "equipment_type_components_equipment_type_id_fkey"
  FOREIGN KEY ("equipment_type_id") REFERENCES "equipment_type_refs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "equipment_type_components"
  ADD CONSTRAINT "equipment_type_components_component_type_id_fkey"
  FOREIGN KEY ("component_type_id") REFERENCES "component_type_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_type_components" ADD CONSTRAINT "equipment_type_components_qty_chk"
  CHECK ("default_qty" >= 0);
ALTER TABLE "equipment_type_components" ADD CONSTRAINT "equipment_type_components_qty_source_chk"
  CHECK ("qty_source" IN ('FIXED', 'NOZZLE_SCHEDULE') OR "qty_source" ~ '^ANSWER:[a-z][a-z0-9_]*$');

-- Tenant-root table (carries tenant_id): same policy as part_families and the
-- other M1 tables. Table privileges come from the default privileges.
ALTER TABLE "equipment_type_components" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "equipment_type_components"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);
