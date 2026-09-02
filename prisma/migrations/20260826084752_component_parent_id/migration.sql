-- AlterTable
ALTER TABLE "components" ADD COLUMN     "parent_component_id" INTEGER;

-- CreateIndex
CREATE INDEX "components_parent_component_id_idx" ON "components"("parent_component_id");

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_parent_component_id_fkey" FOREIGN KEY ("parent_component_id") REFERENCES "components"("id") ON DELETE SET NULL ON UPDATE CASCADE;
