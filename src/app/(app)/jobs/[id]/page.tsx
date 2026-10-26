import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadJobHeader } from "@/lib/services/job-detail.read";
import { loadJobSpines, rollupJobSpine } from "@/lib/services/spine.read";
import { loadJobMilestones } from "@/lib/services/milestone.read";
import { loadEvents } from "@/lib/services/events.read";
import { loadJobGantt } from "@/lib/services/gantt.read";
import { loadBomTree } from "@/lib/services/bom.read";
import { loadAssemblyGrid } from "@/lib/services/assembly.read";
import { loadQcpGrid } from "@/lib/services/qcp-grid.read";
import { loadQcpAttachOptions } from "@/lib/services/job-intake.read";
import { loadClientPreview } from "@/lib/services/client-snapshot.read";
import { loadPackingPanel } from "@/lib/services/packing.read";
import { loadDispatchPanel, loadDispatchReadiness } from "@/lib/services/dispatch.read";
import { loadJobMaterials } from "@/lib/services/job-materials.read";
import { loadQcCounts, loadQcQueue, resolveQcAccess } from "@/lib/services/qc-queue.read";
import { FEATURES } from "@/lib/shared/flags";
import { jobTabUrl, parseMaterialsView, resolveJobTab } from "@/lib/shared/job-tabs";
import { QC_RECORD_ROLES, type QcQuery } from "@/lib/shared/qc-queue";
import { JobDetailClient } from "./_client";
import { IMPORT_ROLES } from "@/lib/services/job-import.service";
import { SWITCH_OVER_ROLES } from "@/lib/services/switch-over.read";
import { storesAccess } from "@/lib/shared/stores-access";
import { MaterialsTab } from "./_tabs/materials-tab";
import { QcTab } from "./_tabs/qc-tab";
import { DispatchTab } from "./_tabs/dispatch-tab";

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

  // Lean Core freeze: false hides the Client View tab.
  const canReviewClientUpdates = FEATURES.clientPortal && hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.MANAGEMENT, ROLES.ADMIN);
  // Not behind cpmReplanUi: a missing or wrong delivery date must stay fixable.
  // The action only schedules a job that has no schedule yet while replan is frozen.
  // The details editor stays behind the freeze, as before; only the date editor is open.
  const canEditJobDetails = FEATURES.cpmReplanUi && hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  const canEditJobDates = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  // Matches S6's gate on createPackage/assignUnitToPackage exactly — UI is
  // cosmetic, the server is authoritative either way.
  const canManagePacking = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  const canVerify = resolveQcAccess(actor).inspect;
  // S6 gated all five dispatch mutations (create/add/approve/record) to the
  // same PRODUCTION_HEAD/ADMIN pair — one boolean covers all of them.
  const canManageDispatch = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  // AUD-003: approveQcpWaiver's own role gate — same pair as
  // createDispatchBatch/approveDispatchRelease.
  const canApproveQcpWaiver = hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  // recordQcpExecution's own role gate (the QCP grid's Record… / Reject / Clear).
  const canRecordQcp = hasRole(actor, ...QC_RECORD_ROLES);

  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();

  const sp = await searchParams;
  // Lean Core L2.8: with `leanFloor` on the page has Overview · Board · Schedule ·
  // Materials · QC · Dispatch · History; off, today's tabs. A name from the other
  // set is redirected (not dropped), so an old link or a shared one still lands.
  const lean = FEATURES.leanFloor;
  const resolved = resolveJobTab(first(sp.tab), { lean, clientPortal: FEATURES.clientPortal });
  if (resolved.redirect) redirect(jobTabUrl(jobId, resolved.tab, sp, resolved.extra));
  const tab = resolved.tab;
  const unitParam = toInt(sp.unit);
  const equipmentParam = toInt(sp.equipment);
  const openUnit = toInt(sp.openUnit);
  const openStage = toInt(sp.openStage);

  // The lean names render the legacy bodies where they are the same view.
  const view = tab === "schedule" ? "gantt" : tab === "history" ? "activity" : tab;
  const matView = parseMaterialsView(first(sp.view));
  const qcView = lean && resolveQcAccess(actor).view;
  const leanMaterials = lean && tab === "materials";
  const leanQc = lean && tab === "qc";
  const leanDispatch = lean && tab === "dispatch";
  const qcQuery = (t: QcQuery["tab"]): QcQuery => ({ tab: t, jobId, unitId: null, page: 1 });

  const [header, unitSpines, milestones, events, gantt, bom, assembly, qcp, packing, dispatch, clientPreview, materials, readiness, qcCounts, qcHolds, qcNcrs, qcpAttach] = await Promise.all([
    loadJobHeader(actor, jobId),
    loadJobSpines(actor, jobId),
    view === "overview" ? loadJobMilestones(actor, jobId) : Promise.resolve(null),
    loadEvents(actor, { jobId, limit: view === "activity" ? 100 : 5 }),
    view === "gantt" ? loadJobGantt(actor, jobId) : Promise.resolve(null),
    view === "bom" || (leanMaterials && matView === "parts") ? loadBomTree(actor, jobId, equipmentParam, unitParam) : Promise.resolve(null),
    view === "assembly" ? loadAssemblyGrid(actor, jobId, unitParam) : Promise.resolve(null),
    view === "qcp" || leanQc ? loadQcpGrid(actor, jobId, unitParam) : Promise.resolve(null),
    view === "packing" || leanDispatch ? loadPackingPanel(actor, jobId) : Promise.resolve(null),
    view === "dispatch" ? loadDispatchPanel(actor, jobId) : Promise.resolve(null),
    view === "client" && canReviewClientUpdates ? loadClientPreview(actor, jobId) : Promise.resolve(null),
    leanMaterials && matView === "pipeline" ? loadJobMaterials(actor, jobId) : Promise.resolve(null),
    leanDispatch ? loadDispatchReadiness(actor, jobId) : Promise.resolve(null),
    // QC counts for the Overview tile and the QC tab: the queue's own definitions, scoped to this job.
    qcView && (tab === "overview" || leanQc) ? loadQcCounts(actor, { jobId }) : Promise.resolve(null),
    qcView && leanQc ? loadQcQueue(actor, qcQuery("holds")) : Promise.resolve(null),
    qcView && leanQc ? loadQcQueue(actor, qcQuery("ncrs")) : Promise.resolve(null),
    // JG2: the picker for a job with no QC plan; the loader returns null once one is attached.
    leanQc && hasRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN) ? loadQcpAttachOptions(actor, jobId) : Promise.resolve(null),
  ]);
  if (!header) notFound();

  const spines = unitSpines ?? [];
  const jobRollup = rollupJobSpine(spines);

  let slot: ReactNode = null;
  if (leanMaterials) {
    slot = <MaterialsTab jobId={jobId} view={matView} onlyShort={first(sp.short) === "1"} materials={materials} parts={bom} canImport={hasRole(actor, ...IMPORT_ROLES)} canSwitchOver={FEATURES.leanFloor && hasRole(actor, ...SWITCH_OVER_ROLES)} access={storesAccess(actor.roles)} canVerify={canVerify} itemId={toInt(sp.item) ?? null} />;
  } else if (leanQc) {
    slot = (
      <QcTab
        jobId={jobId}
        queue={
          qcCounts && qcHolds && qcNcrs
            ? {
                counts: qcCounts,
                holds: qcHolds.holds.flatMap((g) => g.units.flatMap((u) => u.rows)),
                ncrs: qcNcrs.ncrs.flatMap((g) => g.units.flatMap((u) => u.rows)),
              }
            : null
        }
        qcp={qcp}
        canApproveWaiver={canApproveQcpWaiver}
        canRecord={canRecordQcp}
        attachOptions={qcpAttach}
      />
    );
  } else if (leanDispatch) {
    slot = <DispatchTab jobId={jobId} packing={packing} dispatch={dispatch} readiness={readiness} canManagePacking={canManagePacking} canManageDispatch={canManageDispatch} />;
  }

  return (
    <JobDetailClient
      jobId={jobId}
      header={header}
      unitSpines={spines}
      milestones={milestones}
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
      canEditJobDetails={canEditJobDetails}
      canManagePacking={canManagePacking}
      canManageDispatch={canManageDispatch}
      canApproveQcpWaiver={canApproveQcpWaiver}
      canRecordQcp={canRecordQcp}
      storesAccess={storesAccess(actor.roles)}
      canVerify={canVerify}
      tab={tab}
      lean={lean}
      slot={slot}
      openHolds={qcCounts ? qcCounts.holds : null}
      openUnit={openUnit}
      openStage={openStage}
    />
  );
}
