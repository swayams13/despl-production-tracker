-- B8, Phase 4: heat/MTC traceability moves from equipment-shared `BomItem`
-- grain down to per-serial `Component` grain. `component_id` is nullable
-- (equipment with no per-unit `Component` fan-out stays at `bom_item_id`
-- grain — see the model's doc comment); `bom_item_id` stays required and
-- unchanged, so every existing row is untouched.
--
-- Rollback: ALTER TABLE material_identifications DROP COLUMN component_id,
-- DROP COLUMN qty_issued; drops only the new traceability detail, not the
-- existing bom_item_id-grain records.

-- AlterTable
ALTER TABLE "material_identifications"
  ADD COLUMN "component_id" INTEGER,
  ADD COLUMN "qty_issued" DECIMAL(12,3);

-- CreateIndex
CREATE INDEX "material_identifications_component_id_idx" ON "material_identifications"("component_id");

-- AddForeignKey
ALTER TABLE "material_identifications" ADD CONSTRAINT "material_identifications_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE SET NULL ON UPDATE CASCADE;
