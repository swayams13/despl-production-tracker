-- B9, Phase 4: DrawingRevision as its own child rows — invariant #9's
-- versioning convention (a new revision is a new row; a prior RELEASED
-- revision flips to SUPERSEDED, never overwritten/deleted). `AssemblyDrawing`
-- previously carried revision_no/status/approved_date/released_date/
-- revised_date as flat, overwritten fields — mutating them in place on every
-- revision destroyed the prior one. Re-verified before writing this
-- no-backfill migration: zero application code outside prisma/seed.ts and
-- scripts/seed-despl320-and-de0467.ts reads or writes AssemblyDrawing (grepped
-- src/ for `AssemblyDrawing`/`assemblyDrawing\.`) — the ~10 rows present in
-- despl/despl_test are 100% reproducible seed fixtures from seed/live-jobs.json,
-- not data entered through the app by a real user, so this drops them without
-- risk; both seed scripts are updated in the same commit to populate
-- DrawingRevision instead. Rollback: drop drawing_revisions, restore
-- AssemblyDrawing's five dropped columns, drop components.governing_drawing_id
-- / components.built_to_revision_id and the CUTTING gate call in
-- component.service.ts.

-- AlterEnum
ALTER TYPE "DrawingStatus" ADD VALUE 'SUPERSEDED';

-- AlterTable
ALTER TABLE "assembly_drawings"
  DROP COLUMN "revision_no",
  DROP COLUMN "status",
  DROP COLUMN "approved_date",
  DROP COLUMN "released_date",
  DROP COLUMN "revised_date";

-- AlterTable
ALTER TABLE "components"
  ADD COLUMN "governing_drawing_id" INTEGER,
  ADD COLUMN "built_to_revision_id" INTEGER;

-- CreateTable
CREATE TABLE "drawing_revisions" (
    "id" SERIAL NOT NULL,
    "assembly_drawing_id" INTEGER NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "status" "DrawingStatus" NOT NULL DEFAULT 'DRAFT',
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drawing_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "drawing_revisions_assembly_drawing_id_idx" ON "drawing_revisions"("assembly_drawing_id");

-- CreateIndex
CREATE UNIQUE INDEX "drawing_revisions_assembly_drawing_id_revision_no_key" ON "drawing_revisions"("assembly_drawing_id", "revision_no");

-- CreateIndex
CREATE INDEX "components_governing_drawing_id_idx" ON "components"("governing_drawing_id");

-- CreateIndex
CREATE INDEX "components_built_to_revision_id_idx" ON "components"("built_to_revision_id");

-- AddForeignKey
ALTER TABLE "drawing_revisions" ADD CONSTRAINT "drawing_revisions_assembly_drawing_id_fkey" FOREIGN KEY ("assembly_drawing_id") REFERENCES "assembly_drawings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_governing_drawing_id_fkey" FOREIGN KEY ("governing_drawing_id") REFERENCES "assembly_drawings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_built_to_revision_id_fkey" FOREIGN KEY ("built_to_revision_id") REFERENCES "drawing_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
