-- Lean Core J4c: assembly sequence as master data. Additive and forward-only.
-- Who imported (prepared) and who published (approved) an assembly template version.
-- Null on every existing version: nothing changes for jobs already pinned to one.
ALTER TABLE "assembly_template_versions" ADD COLUMN "prepared_by_id" INTEGER;
ALTER TABLE "assembly_template_versions" ADD COLUMN "approved_by_id" INTEGER;

ALTER TABLE "assembly_template_versions"
  ADD CONSTRAINT "assembly_template_versions_prepared_by_id_fkey"
  FOREIGN KEY ("prepared_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assembly_template_versions"
  ADD CONSTRAINT "assembly_template_versions_approved_by_id_fkey"
  FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
