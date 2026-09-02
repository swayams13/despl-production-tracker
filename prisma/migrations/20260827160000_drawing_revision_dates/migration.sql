-- B9, Phase 4 (task review Important): AssemblyDrawing's old approved_date/
-- revised_date columns were dropped by 20260827150000_drawing_revision
-- without a new home — the brief's own wording ("moved onto the revision
-- rows") plus real seed data (e.g. DE0463-001's 2026-07-04 approval /
-- 2026-07-22 revision) meant those dates simply ceased to exist anywhere.
-- Adds them to drawing_revisions, alongside released_at. No backfill: this
-- follows the same no-real-data-at-risk migration
-- (20260827150000_drawing_revision) by one commit, so drawing_revisions
-- itself has zero rows anywhere except what prisma/seed.ts's own re-run
-- (updated in the same commit as this migration) recreates.

-- AlterTable
ALTER TABLE "drawing_revisions"
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "revised_at" TIMESTAMP(3);
