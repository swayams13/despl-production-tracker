import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadProductFamilyAdmin } from "@/lib/services/job-intake.read";
import { ProductFamiliesClient } from "./_client";

export default async function ProductFamiliesPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/admin");

  const rows = await loadProductFamilyAdmin(actor);
  const canCreate = hasRole(actor, ROLES.ADMIN);

  return <ProductFamiliesClient rows={rows} canCreate={canCreate} />;
}
