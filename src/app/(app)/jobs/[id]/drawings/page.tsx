import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadJobDrawings } from "@/lib/services/drawings.read";
import { DrawingsClient } from "./_client";

/**
 * Lean Core JG1: the job's drawings, their release state for H3, and the
 * pressure parts that no drawing governs yet. Readable by every internal role;
 * the controls follow the viewer's role.
 */
export default async function DrawingsPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  const jobId = Number((await params).id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();
  const view = await loadJobDrawings(actor, jobId).catch(() => null);
  if (!view) notFound();
  return <DrawingsClient view={view} />;
}
