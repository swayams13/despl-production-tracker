import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadDailyDigest, loadDigestHistory } from "@/lib/services/reports.read";
import { ReportsClient } from "./_client";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** IST "yesterday", as a YYYY-MM-DD string — the default digest date. */
function defaultDate(): string {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  nowIst.setUTCDate(nowIst.getUTCDate() - 1);
  return nowIst.toISOString().slice(0, 10);
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const sp = await searchParams;
  const dateParam = first(sp.date);
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : defaultDate();

  const [digest, history] = await Promise.all([loadDailyDigest(actor, date), loadDigestHistory(actor)]);
  const canSend = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);

  return <ReportsClient digest={digest} history={history} canSend={canSend} />;
}
