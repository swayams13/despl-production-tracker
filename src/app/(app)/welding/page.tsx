import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadWeldingView } from "@/lib/services/welding.read";
import { loadJobs } from "@/lib/services/jobs.read";
import { WeldingClient } from "./_client";

export default async function WeldingPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const [view, jobs] = await Promise.all([loadWeldingView(actor), loadJobs(actor)]);
  const jobOptions = jobs.map((j) => ({ jobId: j.id, jobNumber: j.jobNumber }));
  const canManageWelders = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return <WeldingClient view={view} jobs={jobOptions} canManageWelders={canManageWelders} />;
}
