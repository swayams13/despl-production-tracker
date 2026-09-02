-- B3, Phase 4: the BomRevision model (invariant #9's versioning convention —
-- new revision = new row, never an edit to a released one). `bom_items.bom_revision_id`
-- is added nullable here; scripts/backfill-bom-revision.ts (companion script,
-- same pattern as B1's scripts/backfill-bom-item-qty-per.ts) creates one
-- RELEASED "Revision 1" row per distinct equipment_id already in bom_items
-- and backfills every existing row onto it, since the seed data has always
-- been the de-facto released BOM. Rollback: drop bom_items.bom_revision_id
-- and the bom_revisions table; bom.read.ts's requiredQty would need its
-- bomRevisionId dependency removed too.
-- CreateEnum
CREATE TYPE "BomRevisionStatus" AS ENUM ('DRAFT', 'RELEASED');

-- AlterTable
ALTER TABLE "bom_items" ADD COLUMN     "bom_revision_id" INTEGER;

-- CreateTable
CREATE TABLE "bom_revisions" (
    "id" SERIAL NOT NULL,
    "equipment_id" INTEGER NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "status" "BomRevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "released_at" TIMESTAMP(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bom_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bom_revisions_equipment_id_idx" ON "bom_revisions"("equipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "bom_revisions_equipment_id_revision_no_key" ON "bom_revisions"("equipment_id", "revision_no");

-- CreateIndex
CREATE INDEX "bom_items_bom_revision_id_idx" ON "bom_items"("bom_revision_id");

-- AddForeignKey
ALTER TABLE "bom_revisions" ADD CONSTRAINT "bom_revisions_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_bom_revision_id_fkey" FOREIGN KEY ("bom_revision_id") REFERENCES "bom_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
