import { redirectToLogin } from "@/lib/auth/login-redirect";
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
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");

  // AUD-037: NCRs name the person who caused them, so both screens are role-gated
  // (QC_VIEW_ROLES); the legacy cockpit used to show every NCR to every staff user.
  if (!resolveQcAccess(actor).view) redirect(landingFor(actor.roles, { leanFloor: FEATURES.leanFloor }));

  // L2.6: with the lean floor on, /qc is the queue (paged, URL-driven).
  // Off, the cockpit below is unchanged.
  if (FEATURES.leanFloor) {
    const view = await loadQcQueue(actor, parseQcQuery(await searchParams));
    return <QcQueueClient view={view} viewerId={actor.userId} />;
  }

  const cockpit = await loadQcCockpit(actor);
  // Only QC dispositions an ordinary NCR (ncr.service); the Production Head sees the list, not the button.
  return <QcCockpitClient cockpit={cockpit} canDisposition={resolveQcAccess(actor).disposition} />;
}
