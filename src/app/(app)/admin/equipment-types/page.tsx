import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadEquipmentTypeAdmin, loadIntakeOptions } from "@/lib/services/job-intake.read";
import { EquipmentTypesClient } from "./_client";

export default async function EquipmentTypesPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/admin");

  const [rows, options] = await Promise.all([loadEquipmentTypeAdmin(actor), loadIntakeOptions(actor)]);
  const families = options.families.map((f) => ({ id: f.id, code: f.code, name: f.name }));

  return <EquipmentTypesClient rows={rows} families={families} />;
}
