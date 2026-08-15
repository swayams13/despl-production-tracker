import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadJobHeader } from "@/lib/services/job-detail.read";
import { loadJobSpines, rollupJobSpine } from "@/lib/services/spine.read";
import { loadEvents } from "@/lib/services/events.read";
import { JobDetailClient } from "./_client";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function JobDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();

  const sp = await searchParams;
  const tab = first(sp.tab) === "activity" ? "activity" : "overview";

  const [header, unitSpines, events] = await Promise.all([
    loadJobHeader(actor, jobId),
    loadJobSpines(actor, jobId),
    loadEvents(actor, { jobId, limit: tab === "activity" ? 100 : 5 }),
  ]);
  if (!header) notFound();

  const spines = unitSpines ?? [];
  const jobRollup = rollupJobSpine(spines);

  return (
    <JobDetailClient
      jobId={jobId}
      header={header}
      unitSpines={spines}
      jobRollup={jobRollup}
      events={events}
      tab={tab}
    />
  );
}
