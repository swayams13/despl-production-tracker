import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { landingFor } from "@/lib/shared/nav";
import { FEATURES } from "@/lib/shared/flags";

/**
 * Role-based landing redirect: forced password change and client users first,
 * then `landingFor` (the nav registry's landing table, L2.1). No page of its
 * own: every role lands on a real page inside the (app) shell.
 */
export default async function Home() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) redirect("/account/password");
  if (actor.clientId !== null) redirect("/portal");
  redirect(landingFor(actor.roles, { leanFloor: FEATURES.leanFloor }));
}
