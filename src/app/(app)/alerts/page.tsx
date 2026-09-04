import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadNotifications } from "@/lib/services/notifications.read";
import { AlertsClient } from "./_client";

export default async function Alerts() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  // S14 — was a stub. loadNotifications/the Notification model/the bell
  // dropdown all already existed; this just renders the real list full-page
  // instead of the bell's 20-row preview.
  const notifications = await loadNotifications(actor, 200);
  return <AlertsClient notifications={notifications} />;
}
