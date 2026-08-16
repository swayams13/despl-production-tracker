import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";

/**
 * Role-based landing redirect (SPEC §7.1: management-tier → Dashboard,
 * supervisor/QC → /my-day, forced password-change → account/password).
 * No page of its own — every role lands on a real page inside the (app) shell.
 */
export default async function Home() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) redirect("/account/password");
  if (actor.clientId !== null) redirect("/portal");
  if (hasRole(actor, ROLES.MANAGEMENT, ROLES.PRODUCTION_HEAD, ROLES.ADMIN)) redirect("/dashboard");
  if (hasRole(actor, ROLES.SUPERVISOR, ROLES.QC)) redirect("/my-day");
  redirect("/workspace"); // fallback for any authenticated shape none of the above catch (e.g. a staff CLIENT_VIEWER with no clientId) — a real page beats a blank one
}
