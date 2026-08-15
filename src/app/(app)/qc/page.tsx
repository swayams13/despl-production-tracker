import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadQcCockpit } from "@/lib/services/qc-cockpit.read";
import { QcCockpitClient } from "./_client";

export default async function QcCockpit() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const cockpit = await loadQcCockpit(actor);
  return <QcCockpitClient cockpit={cockpit} />;
}
