import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadTemplateIndex } from "@/lib/services/template.read";
import { TemplateIndexClient } from "./_client";

export default async function TemplatesPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/dashboard");

  const families = await loadTemplateIndex(actor);
  return <TemplateIndexClient families={families} />;
}
