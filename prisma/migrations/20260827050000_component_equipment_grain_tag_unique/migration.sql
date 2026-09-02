-- Restores DB-level uniqueness for equipment-grain Component rows (unitId
-- IS NULL), which components_unit_id_tag_key cannot cover — Postgres treats
-- NULL as distinct per row in a plain unique index. The prior
-- @@unique([equipmentId, tag]) covered this case but was dropped in
-- 20260826140000_component_unit_tag_unique in favor of unit-grain uniqueness,
-- leaving equipment-grain tags enforced only by seed-script naming
-- convention (code review, 27 Aug 2026). A partial index isn't representable
-- in Prisma's schema DSL — see the comment on Component.tag in schema.prisma
-- — so this migration is hand-authored and has no corresponding schema.prisma
-- change; do not let a future `prisma migrate dev` drop it as drift.
CREATE UNIQUE INDEX "components_equipment_id_tag_equipment_grain_key"
  ON "components"("equipment_id", "tag")
  WHERE "unit_id" IS NULL;
