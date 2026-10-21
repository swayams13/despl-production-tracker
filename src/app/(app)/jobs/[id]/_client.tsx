"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { StageSpine } from "@/components/industrial/stage-spine";
import { StatusChip } from "@/components/industrial/status-chip";
import { STAGE_STATUS, showsOverduePip, showsRejectedMarker, type StageSegment, type StageDisplayStatus } from "@/components/industrial/stage-status";
import { JobGantt } from "@/components/industrial/job-gantt";
import { BomPanel } from "@/components/industrial/bom-panel";
import type { StoresAccess } from "@/lib/shared/stores-access";
import { AssemblyPanel } from "@/components/industrial/assembly-panel";
import { QcpGrid } from "@/components/industrial/qcp-grid";
import { PackingPanel } from "@/components/industrial/packing-panel";
import { DispatchPanel } from "@/components/industrial/dispatch-panel";
import { useStageSheetLauncher, StageSheetLauncher } from "@/components/industrial/stage-sheet-launcher";
import { clickableRowProps } from "@/components/industrial/data-table";
import { JobTabStrip } from "./_tabs/job-tab-strip";
import { OverviewTiles } from "./_tabs/overview-tiles";
import { ClientPortalView } from "@/components/industrial/client-portal-view";
import { ClientReviewBanner } from "@/components/industrial/client-review-banner";
import { JobDateEditor } from "@/components/industrial/job-date-editor";
import { JobDetailsEditor } from "@/components/industrial/job-details-editor";
import { TravellersLink } from "./travellers-link";
import type { JobHeader } from "@/lib/services/job-detail.read";
import type { UnitSpine } from "@/lib/services/spine.read";
import type { ActivityEvent } from "@/lib/services/events.read";
import type { JobGanttData } from "@/lib/services/gantt-layout";
import type { BomTree } from "@/lib/services/bom.read";
import type { AssemblyGrid } from "@/lib/services/assembly.read";
import type { QcpGrid as QcpGridData } from "@/lib/services/qcp-grid.read";
import type { PackingPanel as PackingPanelData } from "@/lib/services/packing.read";
import type { DispatchPanel as DispatchPanelData } from "@/lib/services/dispatch.read";
import type { ClientPreview } from "@/lib/services/client-snapshot.read";
import type { JobMilestones } from "@/lib/shared/milestones";
import { MilestoneStrip } from "@/components/industrial/milestone-strip";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days <= 0) return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

export function JobDetailClient({
  jobId,
  header,
  unitSpines,
  milestones = null,
  jobRollup,
  events,
  gantt,
  bom,
  assembly,
  qcp,
  packing,
  dispatch,
  clientPreview,
  canReviewClientUpdates,
  canEditJobDates,
  canEditJobDetails,
  canManagePacking,
  canManageDispatch,
  canApproveQcpWaiver,
  canRecordQcp,
  storesAccess,
  canVerify,
  tab,
  lean = false,
  slot = null,
  openHolds = null,
  openUnit,
  openStage: openStageParam,
}: {
  jobId: number;
  header: JobHeader;
  unitSpines: UnitSpine[];
  /** J8: null when not loaded (a tab other than Overview). */
  milestones?: JobMilestones | null;
  jobRollup: StageSegment[];
  events: ActivityEvent[];
  gantt: JobGanttData | null;
  bom: BomTree | null;
  assembly: AssemblyGrid | null;
  qcp: QcpGridData | null;
  packing: PackingPanelData | null;
  dispatch: DispatchPanelData | null;
  clientPreview: ClientPreview | null;
  canReviewClientUpdates: boolean;
  canEditJobDates: boolean;
  canEditJobDetails: boolean;
  canManagePacking: boolean;
  canManageDispatch: boolean;
  canApproveQcpWaiver: boolean;
  canRecordQcp: boolean;
  /** What the viewer's role may do to stock (L2.14). */
  storesAccess?: StoresAccess;
  /** QC only: Verify and Reject on a submitted route step in the BOM panel. */
  canVerify?: boolean;
  /** Legacy names (`gantt`, `bom`, `qcp`, `packing`, `dispatch`, `activity`) while `leanFloor` is off, L2.8's (`schedule`, `materials`, `qc`, `dispatch`, `history`) while on. */
  tab: string;
  /** Lean Core L2.8: `leanFloor` is on, so the new tab strip and overview tiles show. */
  lean?: boolean;
  /** The server-rendered body of the Materials, QC and Dispatch tabs (lean only). */
  slot?: ReactNode;
  /** Open hold points on this job; null when the viewer cannot open the QC queue. */
  openHolds?: number | null;
  /** Deep-link from a notification (`?openUnit=&openStage=`) — auto-opens the StageSheet once on mount. */
  openUnit?: number;
  openStage?: number;
}) {
  const { sheet, openStage, refreshStage, closeSheet } = useStageSheetLauncher();
  const openStageInJob = (unitId: number | undefined, stageNo: number) => openStage(jobId, unitId, stageNo);

  useEffect(() => {
    if (openUnit != null && openStageParam != null) openStageInJob(openUnit, openStageParam);
    // Re-fire on a changed deep-link (e.g. a second notification click while
    // this job page stays mounted across a search-param-only navigation) —
    // openStageInJob itself is intentionally excluded, it's a new closure
    // every render and isn't what should gate this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openUnit, openStageParam]);

  const forecastVariance = header.forecastVarianceDays;
  // The lean names for the schedule and history tabs render the same bodies as the legacy ones.
  const view = tab === "schedule" ? "gantt" : tab === "history" ? "activity" : tab;

  return (
    <>
      <div className="page-h">
        <h1 className="mono" style={{ fontSize: "var(--fs-xl, 20px)" }}>{header.jobNumber}</h1>
        <span className="sub">
          {header.equipmentName ?? "—"} · {header.familyName} · {header.unitCount} units
        </span>
        <StatusChip status={header.displayStatus} />
        <TravellersLink jobId={jobId} />
        {canEditJobDetails && (
          <JobDetailsEditor
            jobId={jobId}
            clientOrderNo={header.clientOrderNo}
            projectName={header.projectName}
            poRef={header.poRef}
            designCode={header.designCode}
            priority={header.priority}
            remarks={header.remarks}
          />
        )}
        <span className="sub" style={{ marginLeft: "auto" }}>
          {header.orderDate && (
            <>
              Start <b className="mono" style={{ color: "var(--text)" }}>{fmtDate(header.orderDate)}</b>
              {" · "}
            </>
          )}
          {header.committedDeliveryDate ? (
            <>
              Due <b className="mono" style={{ color: "var(--text)" }}>{fmtDate(header.committedDeliveryDate)}</b>
              {header.forecastDispatch && (
                <>
                  {" "}
                  · forecast{" "}
                  <b className="mono" style={{ color: forecastVariance && forecastVariance > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
                    {fmtDate(header.forecastDispatch)}
                    {forecastVariance != null && ` (${forecastVariance > 0 ? "+" : ""}${forecastVariance}d)`}
                  </b>
                </>
              )}
            </>
          ) : (
            "No contractual date set yet"
          )}
          {canEditJobDates && (
            <JobDateEditor
              jobId={jobId}
              orderDate={header.orderDate}
              committedDeliveryDate={header.committedDeliveryDate}
              targetDispatchDate={header.targetDispatchDate}
            />
          )}
        </span>
      </div>

      {lean ? (
        <JobTabStrip jobId={jobId} tab={tab} showClient={canReviewClientUpdates} />
      ) : (
        <div className="tabs">
          <Link href={`/jobs/${jobId}?tab=overview`} className={`tab${tab === "overview" ? " on" : ""}`}>Overview</Link>
          <Link href={`/jobs/${jobId}/board`} className="tab">Board</Link>
          <Link href={`/jobs/${jobId}?tab=gantt`} className={`tab${tab === "gantt" ? " on" : ""}`}>Timeline (Gantt)</Link>
          <Link href={`/jobs/${jobId}?tab=bom`} className={`tab${tab === "bom" ? " on" : ""}`}>BOM &amp; Components</Link>
          <Link href={`/jobs/${jobId}?tab=assembly`} className={`tab${tab === "assembly" ? " on" : ""}`}>Assembly</Link>
          <Link href={`/jobs/${jobId}?tab=qcp`} className={`tab${tab === "qcp" ? " on" : ""}`}>QCP / Hold points</Link>
          <Link href={`/jobs/${jobId}?tab=packing`} className={`tab${tab === "packing" ? " on" : ""}`}>Packing</Link>
          <Link href={`/jobs/${jobId}?tab=dispatch`} className={`tab${tab === "dispatch" ? " on" : ""}`}>Dispatch</Link>
          <Link href={`/jobs/${jobId}?tab=activity`} className={`tab${tab === "activity" ? " on" : ""}`}>Activity</Link>
          {canReviewClientUpdates && (
            <Link href={`/jobs/${jobId}?tab=client`} className={`tab${tab === "client" ? " on" : ""}`}>Client View</Link>
          )}
        </div>
      )}

      {lean && tab === "overview" && <OverviewTiles jobId={jobId} header={header} openHolds={openHolds} />}
      {lean && tab === "assembly" && (
        <p className="sub" style={{ margin: "0 0 12px" }}>
          <Link href={`/jobs/${jobId}/board`}>← Back to the Board</Link>
        </p>
      )}

      {slot ? (
        slot
      ) : view === "gantt" ? (
        gantt ? <JobGantt data={gantt} onOpenStage={openStageInJob} /> : <p className="note" style={{ margin: "16px 0" }}>No current schedule for this job.</p>
      ) : view === "bom" ? (
        bom ? <BomPanel jobId={jobId} bom={bom} access={storesAccess} canVerify={canVerify} /> : <p className="note" style={{ margin: "16px 0" }}>No BOM loaded for this job.</p>
      ) : view === "assembly" ? (
        assembly ? <AssemblyPanel jobId={jobId} data={assembly} /> : <p className="note" style={{ margin: "16px 0" }}>No assembly data for this job.</p>
      ) : view === "qcp" ? (
        qcp ? <QcpGrid jobId={jobId} data={qcp} canApproveWaiver={canApproveQcpWaiver} canRecord={canRecordQcp} /> : <p className="note" style={{ margin: "16px 0" }}>No QCP template for this job.</p>
      ) : view === "packing" ? (
        packing ? (
          <PackingPanel jobId={jobId} data={packing} canManagePacking={canManagePacking} />
        ) : (
          <p className="note" style={{ margin: "16px 0" }}>No packing data for this job.</p>
        )
      ) : view === "dispatch" ? (
        dispatch ? (
          <DispatchPanel jobId={jobId} data={dispatch} canManageDispatch={canManageDispatch} />
        ) : (
          <p className="note" style={{ margin: "16px 0" }}>No dispatch data for this job.</p>
        )
      ) : view === "client" ? (
        clientPreview ? (
          <ClientPortalView
            jobs={[clientPreview]}
            reviewBanner={<ClientReviewBanner jobId={jobId} preview={clientPreview} />}
          />
        ) : (
          <p className="note" style={{ margin: "16px 0" }}>You don&apos;t have permission to review client updates for this job.</p>
        )
      ) : view === "overview" ? (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hd">
              <h3>Stage spine{jobRollup.length > 0 ? ` — ${jobRollup.length}-stage work order` : ""}</h3>
              <div className="legend">
                <span className="chip c-complete"><i />Done</span>
                <span className="chip c-progress"><i />Active</span>
                <span className="chip c-submitted"><i />QC</span>
                <span className="chip c-overdue"><i />Blocked</span>
                <span className="chip c-idle"><i />Idle</span>
              </div>
            </div>
            <div style={{ padding: 16 }}>
              {jobRollup.length > 0 ? (
                <StageSpine segments={jobRollup} onSegmentClick={(seg) => openStageInJob(seg.unitId, seg.stageNo)} />
              ) : (
                <p className="note" style={{ margin: 0 }}>
                  {milestones?.noStageList ? "No stage list for this type of equipment yet; milestones shown instead." : "No current schedule for this job."}
                </p>
              )}
            </div>
          </div>

          {milestones && (milestones.milestones.length > 0 || milestones.noStageList) && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="hd"><h3>Milestones</h3></div>
              <div style={{ padding: 16 }}>
                <MilestoneStrip milestones={milestones} />
              </div>
            </div>
          )}

          <div className="grid-2">
            <div className="card">
              <div className="hd">
                <h3>Units × stage matrix</h3>
                <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: "var(--fs-xs, 11px)" }}>click a cell to open the stage panel</span>
              </div>
              {unitSpines.length === 0 ? (
                <p className="note" style={{ margin: "16px 0" }}>
                  {milestones?.noStageList ? "No stage list for this type of equipment yet; milestones shown instead." : "No current schedule for this job."}
                </p>
              ) : (
                <div className="uxs">
                  <table>
                    <tbody>
                      <tr>
                        <td className="ulab" />
                        {unitSpines[0].segments.map((s) => (
                          <td key={s.stageNo} style={{ textAlign: "center", color: "#565b63", fontSize: "var(--fs-xs, 11px)" }} className="mono">
                            {s.stageNo}
                          </td>
                        ))}
                      </tr>
                      {unitSpines.map((u) => (
                        <tr key={u.unitId}>
                          <td className="ulab">Unit {u.serialNo}</td>
                          {u.segments.map((s) => (
                            <td key={s.stageNo}>
                              <button
                                type="button"
                                className={`cell${showsOverduePip(s) ? " pip-od" : ""}${showsRejectedMarker(s) ? " pip-rej" : ""}`}
                                style={{ background: STAGE_STATUS[s.status].colorVar }}
                                title={`Unit ${u.serialNo} · Stage ${s.stageNo} · ${s.stageName}`}
                                aria-label={`Unit ${u.serialNo}, Stage ${s.stageNo}, ${s.stageName}`}
                                onClick={() => openStageInJob(u.unitId, s.stageNo)}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <ExceptionsCard unitSpines={unitSpines} onOpenStage={openStageInJob} />
          </div>
        </>
      ) : (
        <div className="card">
          <div className="hd"><h3>Full activity log</h3></div>
          {events.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No activity yet.</p>
          ) : (
            <div>{events.map((e) => <ActivityRow key={e.id} e={e} />)}</div>
          )}
        </div>
      )}

      <StageSheetLauncher sheet={sheet} onOpenChange={closeSheet} onChanged={refreshStage} />
    </>
  );
}

interface Exception {
  unitId: number;
  serialNo: string;
  stageNo: number;
  stageName: string;
  status: StageDisplayStatus;
  rejected?: boolean;
}

/** Every segment across this job's units that needs a decision — overdue,
 * on hold, or carrying a rejected marker. Computed from `unitSpines` (already
 * loaded for the stage spine/matrix above), no new query. */
function computeExceptions(unitSpines: UnitSpine[]): Exception[] {
  const out: Exception[] = [];
  for (const u of unitSpines) {
    for (const s of u.segments) {
      if (s.status === "overdue" || s.status === "hold" || s.rejected) {
        out.push({ unitId: u.unitId, serialNo: u.serialNo, stageNo: s.stageNo, stageName: s.stageName, status: s.status, rejected: s.rejected });
      }
    }
  }
  return out.sort((a, b) => Number(b.rejected) - Number(a.rejected) || Number(a.status !== "overdue") - Number(b.status !== "overdue"));
}

/**
 * Project Control Centre's real second panel per the Round 2 mockup (`01`) —
 * "Exceptions", not an activity log. UX_FINAL_REVIEW.md's own screen review
 * documents this: "Activity-level table deliberately absent — exceptions
 * list links out instead." The full event log is still one click away via
 * the existing "Activity" tab; this replaces what used to be a *duplicate*
 * preview of it on Overview, not a removal of activity history.
 */
function ExceptionsCard({
  unitSpines,
  onOpenStage,
}: {
  unitSpines: UnitSpine[];
  onOpenStage: (unitId: number | undefined, stageNo: number) => void;
}) {
  const exceptions = computeExceptions(unitSpines);
  return (
    <div className="card">
      <div className="hd">
        <h3>Exceptions</h3>
        <span className="chip c-overdue" style={{ marginLeft: "auto" }}><i />{exceptions.length}</span>
      </div>
      {exceptions.length === 0 ? (
        <p className="note" style={{ margin: "16px 0" }}>No exceptions — every stage is on track.</p>
      ) : (
        <div>
          {exceptions.slice(0, 8).map((ex) => (
            <div
              key={`${ex.unitId}-${ex.stageNo}`}
              className="feed-row"
              {...clickableRowProps(() => onOpenStage(ex.unitId, ex.stageNo), `Unit ${ex.serialNo}, ${ex.stageName}`)}
            >
              <StatusChip status={ex.status} label={ex.rejected ? "Rejected" : undefined} />
              <div>
                <b style={{ fontWeight: 500 }}>{ex.stageName}</b> — Unit <span className="mono">{ex.serialNo}</span>
              </div>
            </div>
          ))}
          {exceptions.length > 8 && (
            <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", color: "var(--muted)", fontSize: "var(--fs-xs, 11px)" }}>
              +{exceptions.length - 8} more — see the stage spine and matrix above
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ e }: { e: ActivityEvent }) {
  const initials = e.actorName ? e.actorName.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() : "—";
  return (
    <div className="feed-row">
      <div className="avatar" style={{ width: 24, height: 24, fontSize: "var(--fs-xs, 11px)" }}>{initials}</div>
      <div>
        <b style={{ fontWeight: 500 }}>{e.actorName ?? "System"}</b>{" "}
        {e.label}
        {e.processName && <> — <b>{e.processName}</b>{e.serialNo ? ` · Unit ${e.serialNo}` : ""}</>}
      </div>
      <span className="when">{fmtWhen(e.at)}</span>
    </div>
  );
}
