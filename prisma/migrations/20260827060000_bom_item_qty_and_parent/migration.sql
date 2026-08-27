-- AlterTable
-- B1: qty -> sourceQty is a Prisma-model-only rename (@map("qty") keeps the
-- column name), so no column rename here. Add the parsed-quantity columns
-- and B2's self-referencing parent FK, additive only.
ALTER TABLE "bom_items" ADD COLUMN     "qty_per" DECIMAL(12,3),
ADD COLUMN     "uom" TEXT,
ADD COLUMN     "parent_bom_item_id" INTEGER;

-- CreateIndex
CREATE INDEX "bom_items_parent_bom_item_id_idx" ON "bom_items"("parent_bom_item_id");

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_parent_bom_item_id_fkey" FOREIGN KEY ("parent_bom_item_id") REFERENCES "bom_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
