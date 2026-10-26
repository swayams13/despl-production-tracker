import { redirectToLogin } from "@/lib/auth/login-redirect";
import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadEquipmentTypeAdmin, loadIntakeOptions } from "@/lib/services/job-intake.read";
import { loadAssemblyVersions } from "@/lib/services/assembly-template.service";
import { withTenant } from "@/lib/db";
import { EquipmentTypesClient } from "./_client";

export default async function EquipmentTypesPage() {
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/admin");

  const [rows, options] = await Promise.all([loadEquipmentTypeAdmin(actor), loadIntakeOptions(actor)]);
  const families = options.families.map((f) => ({ id: f.id, code: f.code, name: f.name }));

  // Lean Core J4c: each type's assembly sequence versions (read-only here; import and publish are actions).
  const assemblyTypes = await Promise.all(
    rows.filter((r) => r.active).map(async (r) => ({ id: r.id, code: r.code, name: r.name, versions: await loadAssemblyVersions(actor, r.id) })),
  );
  const departments = await withTenant(actor.tenantId, (tx) => tx.department.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, name: true } }));

  return (
    <EquipmentTypesClient
      rows={rows}
      families={families}
      questions={options.questions}
      assembly={{
        types: assemblyTypes,
        isHead: hasRole(actor, ROLES.PRODUCTION_HEAD),
        currentUserId: actor.userId,
        departmentNames: Object.fromEntries(departments.map((d) => [d.id, d.name])),
      }}
    />
  );
}
