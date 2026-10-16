import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { FEATURES } from "@/lib/shared/flags";
import { loadToday } from "@/lib/services/today.read";
import { TodayClient } from "./_client";

/**
 * Lean Core L2.3: Today, the personal list. Behind `leanFloor` (its writes are
 * recordWork's): while the switch is off /my-day stays the page and this is a
 * plain 404. Mine only; the team's work lives under Team.
 */
export default async function TodayPage() {
  if (!FEATURES.leanFloor) notFound();
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const view = await loadToday(actor);
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  return (
    <TodayClient
      view={view}
      name={actor.name}
      afterFour={nowIst.getUTCHours() >= 16}
      dateLabel={new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}
    />
  );
}
