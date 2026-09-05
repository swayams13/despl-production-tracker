import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadRouteTemplateAdmin } from "@/lib/services/job-intake.read";
import { RouteTemplateAdminClient } from "./_client";

export default async function RouteTemplateAdminPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/admin");

  const admin = await loadRouteTemplateAdmin(actor);
  return <RouteTemplateAdminClient admin={admin} />;
}
