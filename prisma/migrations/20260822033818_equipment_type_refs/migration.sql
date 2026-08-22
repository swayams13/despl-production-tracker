-- AlterTable
ALTER TABLE "equipments" ADD COLUMN     "equipment_type_id" INTEGER;

-- CreateTable
CREATE TABLE "equipment_type_refs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_design_code" TEXT,
    "default_specs" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "equipment_type_refs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "equipment_type_refs_tenant_id_idx" ON "equipment_type_refs"("tenant_id");

-- CreateIndex
CREATE INDEX "equipment_type_refs_family_id_idx" ON "equipment_type_refs"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_type_refs_tenant_id_code_key" ON "equipment_type_refs"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "equipments_equipment_type_id_idx" ON "equipments"("equipment_type_id");

-- AddForeignKey
ALTER TABLE "equipment_type_refs" ADD CONSTRAINT "equipment_type_refs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_type_refs" ADD CONSTRAINT "equipment_type_refs_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipments" ADD CONSTRAINT "equipments_equipment_type_id_fkey" FOREIGN KEY ("equipment_type_id") REFERENCES "equipment_type_refs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant RLS on the new tenant-root table. equipment_type_refs carries
-- tenant_id, so it belongs with clients/departments/component_type_refs in
-- the fail-closed policy set; a tenant-root table with no policy is a silent
-- cross-tenant read. `equipments` gets none — it is a job-child, reachable
-- only via jobs, which does have a policy.
ALTER TABLE "equipment_type_refs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "equipment_type_refs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);
