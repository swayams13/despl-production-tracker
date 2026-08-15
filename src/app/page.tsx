import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";

/**
 * Role-based landing redirect (DESIGN_SPEC: supervisor/QC → Workspace,
 * management-tier → company Dashboard). No page of its own — every role
 * lands on a real page inside the (app) shell.
 */
export default async function Home() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (hasRole(actor, ROLES.MANAGEMENT, ROLES.PRODUCTION_HEAD, ROLES.ADMIN)) redirect("/dashboard");
  redirect("/workspace");
}
