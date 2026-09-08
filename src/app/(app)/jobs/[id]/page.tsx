import { notFound, redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadJobHeader } from "@/lib/services/job-detail.read";
import { loadJobSpines, rollupJobSpine } from "@/lib/services/spine.read";
import { loadEvents } from "@/lib/services/events.read";
import { loadJobGantt } from "@/lib/services/gantt.read";
import { loadBomTree } from "@/lib/services/bom.read";
import { loadAssemblyGrid } from "@/lib/services/assembly.read";
import { loadQcpGrid } from "@/lib/services/qcp-grid.read";
import { loadClientPreview } from "@/lib/services/client-snapshot.read";
import { loadPackingPanel } from "@/lib/services/packing.read";
import { loadDispatchPanel } from "@/lib/services/dispatch.read";
import { JobDetailClient } from "./_client";

const TABS = ["overview", "gantt", "bom", "assembly", "qcp", "packing", "dispatch", "activity", "client"] as const;
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

  const canReviewClientUpdates = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.MANAGEMENT, ROLES.ADMIN);
  const canEditJobDates = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  // Matches S6's gate on createPackage/assignUnitToPackage exactly — UI is
  // cosmetic, the server is authoritative either way.
  const canManagePacking = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  // S6 gated all five dispatch mutations (create/add/approve/record) to the
  // same PRODUCTION_HEAD/ADMIN pair — one boolean covers all of them.
  const canManageDispatch = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  // AUD-003: approveQcpWaiver's own role gate — same pair as
  // createDispatchBatch/approveDispatchRelease.
  const canApproveQcpWaiver = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);

  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();

  const sp = await searchParams;
  const tabParam = first(sp.tab);
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as Tab) : "overview";
  const unitParam = toInt(sp.unit);
  const equipmentParam = toInt(sp.equipment);
  const openUnit = toInt(sp.openUnit);
  const openStage = toInt(sp.openStage);

  const [header, unitSpines, events, gantt, bom, assembly, qcp, packing, dispatch, clientPreview] = await Promise.all([
    loadJobHeader(actor, jobId),
    loadJobSpines(actor, jobId),
    loadEvents(actor, { jobId, limit: tab === "activity" ? 100 : 5 }),
    tab === "gantt" ? loadJobGantt(actor, jobId) : Promise.resolve(null),
    tab === "bom" ? loadBomTree(actor, jobId, equipmentParam, unitParam) : Promise.resolve(null),
    tab === "assembly" ? loadAssemblyGrid(actor, jobId, unitParam) : Promise.resolve(null),
    tab === "qcp" ? loadQcpGrid(actor, jobId, unitParam) : Promise.resolve(null),
    tab === "packing" ? loadPackingPanel(actor, jobId) : Promise.resolve(null),
    tab === "dispatch" ? loadDispatchPanel(actor, jobId) : Promise.resolve(null),
    tab === "client" && canReviewClientUpdates ? loadClientPreview(actor, jobId) : Promise.resolve(null),
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
      assembly={assembly}
      qcp={qcp}
      packing={packing}
      dispatch={dispatch}
      clientPreview={clientPreview}
      canReviewClientUpdates={canReviewClientUpdates}
      canEditJobDates={canEditJobDates}
      canManagePacking={canManagePacking}
      canManageDispatch={canManageDispatch}
      canApproveQcpWaiver={canApproveQcpWaiver}
      tab={tab}
      openUnit={openUnit}
      openStage={openStage}
    />
  );
}
