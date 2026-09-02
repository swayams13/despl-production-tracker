-- Tenant RLS on the new tenant-root table added by the assembly_tracking
-- migration (Phase 2 / A1). assembly_templates carries tenant_id, so it
-- belongs with equipment_type_refs/welders in the fail-closed policy set —
-- a tenant-root table with no policy is a silent cross-tenant read
-- (rls-coverage.test.ts would have caught this before it shipped, and did).
-- assembly_template_versions/assembly_template_steps/assembly_steps/
-- assembly_step_rejections carry no tenant_id — they're job/unit-children,
-- reachable only through jobs/units, which already have a policy.
ALTER TABLE "assembly_templates" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "assembly_templates"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);
