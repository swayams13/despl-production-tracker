import { redirectToLogin } from "@/lib/auth/login-redirect";
import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadWeldMap } from "@/lib/services/weld-map.service";
import { WeldMapClient } from "./_client";

/**
 * Lean Core J4b (frame 14C): the joint register of each line on the job. Readable by every
 * internal role; the load, add and confirm controls follow the viewer's role.
 */
export default async function WeldMapPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ line?: string }> }) {
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");
  const jobId = Number((await params).id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();
  const view = await loadWeldMap(actor, jobId).catch(() => null);
  if (!view) notFound();
  const line = Number((await searchParams).line);
  return <WeldMapClient view={view} initialLineId={Number.isInteger(line) ? line : null} />;
}
