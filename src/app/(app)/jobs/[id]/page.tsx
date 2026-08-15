import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadJobHeader } from "@/lib/services/job-detail.read";
import { loadJobSpines, rollupJobSpine } from "@/lib/services/spine.read";
import { loadEvents } from "@/lib/services/events.read";
import { loadJobGantt } from "@/lib/services/gantt.read";
import { loadBomTree } from "@/lib/services/bom.read";
import { loadQcpGrid } from "@/lib/services/qcp-grid.read";
import { JobDetailClient } from "./_client";

const TABS = ["overview", "gantt", "bom", "qcp", "activity"] as const;
type Tab = (typeof TABS)[number];

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function toInt(v: string | string[] | undefined): number | undefined {
  const s = first(v);
  const n = s ? Number(s) : NaN;
  return Number.isInteger(n) ? n : undefined;
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
  const tabParam = first(sp.tab);
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as Tab) : "overview";
  const unitParam = toInt(sp.unit);
  const equipmentParam = toInt(sp.equipment);

  const [header, unitSpines, events, gantt, bom, qcp] = await Promise.all([
    loadJobHeader(actor, jobId),
    loadJobSpines(actor, jobId),
    loadEvents(actor, { jobId, limit: tab === "activity" ? 100 : 5 }),
    tab === "gantt" ? loadJobGantt(actor, jobId) : Promise.resolve(null),
    tab === "bom" ? loadBomTree(actor, jobId, equipmentParam) : Promise.resolve(null),
    tab === "qcp" ? loadQcpGrid(actor, jobId, unitParam) : Promise.resolve(null),
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
      gantt={gantt}
      bom={bom}
      qcp={qcp}
      tab={tab}
    />
  );
}
