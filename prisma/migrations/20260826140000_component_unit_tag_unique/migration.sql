-- DropIndex
DROP INDEX "components_equipment_id_tag_key";

-- CreateIndex
CREATE UNIQUE INDEX "components_unit_id_tag_key" ON "components"("unit_id", "tag");
