-- J5a: floor steps are generated at BOM release. Additive only.
--   bom_items.route_variant     the route variant letter chosen for the line (NULL = lowest published letter)
--   bom_revisions.materialized_at  set from the DB clock when the revision's components, operations and steps were generated
ALTER TABLE "bom_items" ADD COLUMN "route_variant" TEXT;
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_route_variant_check" CHECK ("route_variant" IS NULL OR "route_variant" ~ '^[A-Z]$');
ALTER TABLE "bom_revisions" ADD COLUMN "materialized_at" TIMESTAMP(3);
