import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadAdminView } from "@/lib/services/admin.read";
import { AdminClient } from "./_client";

export default async function AdminPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.MANAGEMENT)) redirect("/dashboard");

  const view = await loadAdminView(actor);
  const canEdit = hasRole(actor, ROLES.ADMIN);

  return <AdminClient view={view} canEdit={canEdit} actorUserId={actor.userId} />;
}
