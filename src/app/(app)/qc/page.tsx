import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { FEATURES } from "@/lib/shared/flags";
import { landingFor } from "@/lib/shared/nav";
import { parseQcQuery } from "@/lib/shared/qc-queue";
import { loadQcCockpit } from "@/lib/services/qc-cockpit.read";
import { loadQcQueue, resolveQcAccess } from "@/lib/services/qc-queue.read";
import { QcCockpitClient } from "./_client";
import { QcQueueClient } from "./_queue";

export default async function QcCockpit({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  // L2.6: with the lean floor on, /qc is the queue (role-gated, paged, URL-driven).
  // Off, the cockpit below is unchanged.
  if (FEATURES.leanFloor) {
    if (!resolveQcAccess(actor).view) redirect(landingFor(actor.roles, { leanFloor: true }));
    const view = await loadQcQueue(actor, parseQcQuery(await searchParams));
    return <QcQueueClient view={view} viewerId={actor.userId} />;
  }

  const cockpit = await loadQcCockpit(actor);
  // Only QC dispositions an ordinary NCR (ncr.service); the Production Head sees the list, not the button.
  return <QcCockpitClient cockpit={cockpit} canDisposition={resolveQcAccess(actor).disposition} />;
}
