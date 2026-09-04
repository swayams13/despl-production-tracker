-- B7: display names for the 25-stage work-order reporting view, per family.
-- Replaces src/lib/shared/stage-names.ts's hardcoded, family-agnostic
-- STAGE_NAMES constant.

-- CreateTable
CREATE TABLE "work_order_stages" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "stage_no" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "work_order_stages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_order_stages_tenant_id_idx" ON "work_order_stages"("tenant_id");

-- CreateIndex
CREATE INDEX "work_order_stages_family_id_idx" ON "work_order_stages"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_stages_tenant_id_family_id_stage_no_key" ON "work_order_stages"("tenant_id", "family_id", "stage_no");

-- AddForeignKey
ALTER TABLE "work_order_stages" ADD CONSTRAINT "work_order_stages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_stages" ADD CONSTRAINT "work_order_stages_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant RLS on the new tenant-root table (see rls-coverage.test.ts).
ALTER TABLE "work_order_stages" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "work_order_stages"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);
