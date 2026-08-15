"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StageSpine } from "@/components/industrial/stage-spine";
import { StageSheet } from "@/components/industrial/stage-sheet";
import { StatusChip } from "@/components/industrial/status-chip";
import { STAGE_STATUS, showsOverduePip, showsRejectedMarker, type StageSegment } from "@/components/industrial/stage-status";
import { JobGantt } from "@/components/industrial/job-gantt";
import { BomPanel } from "@/components/industrial/bom-panel";
import { QcpGrid } from "@/components/industrial/qcp-grid";
import { startAction, submitAction, verifyAction, rejectAction } from "@/app/actions/process";
import { fileDelayBulkAction } from "@/app/actions/delay";
import type { ActionResult } from "@/app/actions/_action";
import type { JobHeader } from "@/lib/services/job-detail.read";
import type { UnitSpine } from "@/lib/services/spine.read";
import type { ActivityEvent } from "@/lib/services/events.read";
import type { StageDetail, StageBackingPlan } from "@/lib/services/stage-detail.read";
import type { JobGanttData } from "@/lib/services/gantt-layout";
import type { BomTree } from "@/lib/services/bom.read";
import type { QcpGrid as QcpGridData } from "@/lib/services/qcp-grid.read";

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
  jobRollup,
  events,
  gantt,
  bom,
  qcp,
  tab,
}: {
  jobId: number;
  header: JobHeader;
  unitSpines: UnitSpine[];
  jobRollup: StageSegment[];
  events: ActivityEvent[];
  gantt: JobGanttData | null;
  bom: BomTree | null;
  qcp: QcpGridData | null;
  tab: "overview" | "gantt" | "bom" | "qcp" | "activity";
}) {
  const [sheet, setSheet] = useState<{ open: boolean; loading: boolean; detail: StageDetail | null }>({
    open: false,
    loading: false,
    detail: null,
  });
  const router = useRouter();

  const openStage = async (unitId: number | undefined, stageNo: number) => {
    if (unitId == null) return;
    setSheet({ open: true, loading: true, detail: null });
    try {
      const res = await fetch(`/api/jobs/${jobId}/stage?unit=${unitId}&stage=${stageNo}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Could not load that stage.");
        setSheet({ open: false, loading: false, detail: null });
        return;
      }
      const detail: StageDetail = await res.json();
      setSheet({ open: true, loading: false, detail });
    } catch {
      toast.error("Could not load that stage.");
      setSheet({ open: false, loading: false, detail: null });
    }
  };

  const refreshStage = async () => {
    if (!sheet.detail) return;
    const res = await fetch(`/api/jobs/${jobId}/stage?unit=${sheet.detail.unitId}&stage=${sheet.detail.stageNo}`);
    if (res.ok) {
      const detail: StageDetail = await res.json();
      setSheet((s) => ({ ...s, detail }));
    }
    router.refresh();
  };

  const forecastVariance = header.forecastVarianceDays;

  return (
    <>
      <div className="page-h">
        <h1 className="mono" style={{ fontSize: 20 }}>{header.jobNumber}</h1>
        <span className="sub">
          {header.equipmentName ?? "—"} · {header.familyName} · {header.unitCount} units
        </span>
        <StatusChip status={header.displayStatus} />
        <span className="sub" style={{ marginLeft: "auto" }}>
          {header.deliveryDate ? (
            <>
              Due <b className="mono" style={{ color: "var(--text)" }}>{fmtDate(header.deliveryDate)}</b>
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
        </span>
      </div>

      <div className="tabs">
        <Link href={`/jobs/${jobId}?tab=overview`} className={`tab${tab === "overview" ? " on" : ""}`}>Overview</Link>
        <Link href={`/jobs/${jobId}?tab=gantt`} className={`tab${tab === "gantt" ? " on" : ""}`}>Timeline (Gantt)</Link>
        <Link href={`/jobs/${jobId}?tab=bom`} className={`tab${tab === "bom" ? " on" : ""}`}>BOM &amp; Components</Link>
        <Link href={`/jobs/${jobId}?tab=qcp`} className={`tab${tab === "qcp" ? " on" : ""}`}>QCP / Hold points</Link>
        <Link href={`/jobs/${jobId}?tab=activity`} className={`tab${tab === "activity" ? " on" : ""}`}>Activity</Link>
      </div>

      {tab === "gantt" ? (
        gantt ? <JobGantt data={gantt} onOpenStage={openStage} /> : <p className="note" style={{ margin: "16px 0" }}>No current schedule for this job.</p>
      ) : tab === "bom" ? (
        bom ? <BomPanel jobId={jobId} bom={bom} /> : <p className="note" style={{ margin: "16px 0" }}>No BOM loaded for this job.</p>
      ) : tab === "qcp" ? (
        qcp ? <QcpGrid jobId={jobId} data={qcp} /> : <p className="note" style={{ margin: "16px 0" }}>No QCP template for this job.</p>
      ) : tab === "overview" ? (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hd">
              <h3>Stage spine — 25-stage work order</h3>
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
                <StageSpine segments={jobRollup} onSegmentClick={(seg) => openStage(seg.unitId, seg.stageNo)} />
              ) : (
                <p className="note" style={{ margin: 0 }}>No current schedule for this job.</p>
              )}
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="hd">
                <h3>Units × stage matrix</h3>
                <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>click a cell to open the stage panel</span>
              </div>
              {unitSpines.length === 0 ? (
                <p className="note" style={{ margin: "16px 0" }}>No current schedule for this job.</p>
              ) : (
                <div className="uxs">
                  <table>
                    <tbody>
                      <tr>
                        <td className="ulab" />
                        {unitSpines[0].segments.map((s) => (
                          <td key={s.stageNo} style={{ textAlign: "center", color: "#565b63", fontSize: 9 }} className="mono">
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
                                onClick={() => openStage(u.unitId, s.stageNo)}
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

            <div className="card">
              <div className="hd"><h3>Activity</h3></div>
              {events.length === 0 ? (
                <p className="note" style={{ margin: "16px 0" }}>No activity yet.</p>
              ) : (
                <div>
                  {events.slice(0, 5).map((e) => (
                    <ActivityRow key={e.id} e={e} />
                  ))}
                  <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)" }}>
                    <Link href={`/jobs/${jobId}?tab=activity`} className="btn btn-ghost">Open full activity →</Link>
                  </div>
                </div>
              )}
            </div>
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

      <StageSheetBody
        sheet={sheet}
        onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
        onChanged={refreshStage}
      />
    </>
  );
}

function ActivityRow({ e }: { e: ActivityEvent }) {
  const initials = e.actorName ? e.actorName.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() : "—";
  return (
    <div className="feed-row">
      <div className="avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{initials}</div>
      <div>
        <b style={{ fontWeight: 500 }}>{e.actorName ?? "System"}</b>{" "}
        {e.label}
        {e.processName && <> — <b>{e.processName}</b>{e.serialNo ? ` · Unit ${e.serialNo}` : ""}</>}
      </div>
      <span className="when">{fmtWhen(e.at)}</span>
    </div>
  );
}

function useRun() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, ok: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(ok);
        after?.();
      }
    });
  return { pending, run };
}

function StageSheetBody({
  sheet,
  onOpenChange,
  onChanged,
}: {
  sheet: { open: boolean; loading: boolean; detail: StageDetail | null };
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const { pending, run } = useRun();
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  if (sheet.loading || !sheet.detail) {
    return (
      <StageSheet
        open={sheet.open}
        onOpenChange={onOpenChange}
        title={sheet.loading ? "Loading…" : ""}
        status="idle"
        body={sheet.loading ? <p className="note" style={{ margin: "16px 0" }}>Loading stage detail…</p> : null}
      />
    );
  }

  const d = sheet.detail;
  const governing = d.backingPlans.find((p) => p.isGoverning) ?? null;
  const now = Date.now();
  const reasonedPlanIds = new Set(d.delayReasons.map((r) => r.processPlanId));
  const unreasonedOverduePlanIds = d.backingPlans
    .filter((p) => p.status !== "COMPLETE" && p.plannedFinish != null && new Date(p.plannedFinish).getTime() < now)
    .filter((p) => !reasonedPlanIds.has(p.planId))
    .map((p) => p.planId);
  const overdueReasonPending = unreasonedOverduePlanIds.length > 0;

  return (
    <StageSheet
      open={sheet.open}
      onOpenChange={onOpenChange}
      title={`Stage ${d.stageNo} · ${d.stageName}`}
      status={d.status}
      meta={[
        { label: "Job / Unit", value: `${d.jobNumber} · Unit ${d.serialNo}` },
        { label: "Owner", value: `${d.deptName} — supervisor` },
        { label: "Target", value: `${fmtDate(d.plannedStart)} → ${fmtDate(d.plannedFinish)}` },
        {
          label: "Actual",
          value: d.actualStart ? `${fmtDate(d.actualStart)} → ${d.actualFinish ? fmtDate(d.actualFinish) : "in progress"}` : "not started",
        },
        {
          label: "Variance",
          value:
            d.varianceDays == null ? "—" : (
              <span style={{ color: d.varianceDays > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
                {d.varianceDays > 0 ? `+${d.varianceDays}d overdue` : d.varianceDays < 0 ? `${-d.varianceDays}d ahead` : "on schedule"}
              </span>
            ),
        },
        {
          label: "Std vs elapsed",
          value:
            d.standardDays != null
              ? `${d.standardDays}d standard${d.elapsedDays != null ? ` · ${d.elapsedDays}d elapsed` : ""}`
              : "—",
        },
      ]}
      body={
        <>
          {d.backingPlans.length > 1 && (
            <>
              <div className="sh-sec">Backing processes ({d.backingPlans.length})</div>
              {d.backingPlans.map((p) => (
                <BackingPlanRow key={p.planId} plan={p} pending={pending} run={run} onChanged={onChanged} />
              ))}
            </>
          )}

          <div className="sh-sec">Why on hold</div>
          {d.holdPoints.filter((h) => h.status !== "Cleared").length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>No open hold points for this stage.</p>
          ) : (
            d.holdPoints
              .filter((h) => h.status !== "Cleared")
              .map((h) => (
                <div key={h.qcpItemId} className="hp-row" style={{ padding: "9px 0" }}>
                  <span className="mono" style={{ color: "var(--muted)" }}>{h.srNo}</span>
                  <span className="hclass">{h.classCode}</span>
                  <span>{h.activity}</span>
                  <span className={`chip ${h.status === "Reinspect" ? "c-overdue" : h.status === "QC review" ? "c-submitted" : "c-hold"}`}>
                    <i />{h.status}
                  </span>
                  <span className="mono" style={{ color: "var(--s-overdue)" }}>{h.ageDays}d</span>
                </div>
              ))
          )}

          <div className="sh-sec">Why overdue</div>
          {overdueReasonPending && (
            <p style={{ color: "var(--s-overdue)", fontSize: 12, margin: "0 0 6px" }}>
              Overdue{d.varianceDays != null && d.varianceDays > 0 ? ` ${d.varianceDays}d` : ""} · reason required
              {unreasonedOverduePlanIds.length > 1 && ` for ${unreasonedOverduePlanIds.length} backing processes`}
            </p>
          )}
          {d.delayReasons.length === 0 ? (
            !overdueReasonPending && <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>No delay reasons filed.</p>
          ) : (
            d.delayReasons.map((r) => (
              <div key={r.id} className="sh-hist">
                <div>
                  {r.category}
                  {r.detail && <> — <i>&quot;{r.detail}&quot;</i></>}
                  <small>{r.filedByName} · {fmtDate(r.filedAt)}</small>
                </div>
              </div>
            ))
          )}
          {d.status === "hold" && d.overduePip && (
            <p style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 8 }}>
              Overdue — the open hold point is the likely cause; file the matching reason.
            </p>
          )}

          {d.rejections.length > 0 && (
            <>
              <div className="sh-sec">Rejection history</div>
              {d.rejections.map((r, i) => (
                <div key={i} className="sh-hist">
                  <div>
                    Rejected <b>{r.processName}</b>{r.reason && <> — <i>&quot;{r.reason}&quot;</i></>}
                    <small>{r.actorName ?? "—"} · {fmtDate(r.at)}</small>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      }
      footer={
        governing && (
          <StageSheetFooter
            governing={governing}
            overdue={overdueReasonPending}
            unreasonedOverduePlanIds={unreasonedOverduePlanIds}
            categories={d.delayCategories}
            pending={pending}
            run={run}
            onChanged={onChanged}
            rejecting={rejecting}
            setRejecting={setRejecting}
            rejectReason={rejectReason}
            setRejectReason={setRejectReason}
          />
        )
      }
    />
  );
}

function BackingPlanRow({
  plan,
  pending,
  run,
  onChanged,
}: {
  plan: StageBackingPlan;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok: string, after?: () => void) => void;
  onChanged: () => void;
}) {
  const statusMap: Record<string, "idle" | "progress" | "submitted" | "complete" | "hold"> = {
    NOT_STARTED: "idle",
    IN_PROGRESS: "progress",
    SUBMITTED: "submitted",
    COMPLETE: "complete",
    ON_HOLD: "hold",
  };
  return (
    <div className="hp-row" style={{ gridTemplateColumns: "1fr auto auto", padding: "8px 0" }}>
      <span>{plan.processName}{plan.isGoverning && <span style={{ color: "var(--muted)" }}> (governing)</span>}</span>
      <StatusChip status={statusMap[plan.status] ?? "idle"} />
      {plan.status === "NOT_STARTED" && (
        <button className="btn" disabled={pending} onClick={() => run(() => startAction(plan.planId), "Started.", onChanged)}>Start</button>
      )}
      {plan.status === "IN_PROGRESS" && (
        <button className="btn" disabled={pending} onClick={() => run(() => submitAction(plan.planId), "Submitted for QC.", onChanged)}>Submit</button>
      )}
    </div>
  );
}

function StageSheetFooter({
  governing,
  overdue,
  unreasonedOverduePlanIds,
  categories,
  pending,
  run,
  onChanged,
  rejecting,
  setRejecting,
  rejectReason,
  setRejectReason,
}: {
  governing: StageBackingPlan;
  overdue: boolean;
  unreasonedOverduePlanIds: number[];
  categories: { id: number; name: string }[];
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok: string, after?: () => void) => void;
  onChanged: () => void;
  rejecting: boolean;
  setRejecting: (v: boolean) => void;
  rejectReason: string;
  setRejectReason: (v: string) => void;
}) {
  const [filing, setFiling] = useState(false);
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [detail, setDetail] = useState("");

  if (filing) {
    return (
      <div style={{ display: "flex", gap: 6, width: "100%", flexWrap: "wrap" }}>
        <select className="btn" value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")} aria-label="Delay reason" style={{ flex: 1, minWidth: 140 }}>
          <option value="">Delay reason…</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input className="ws-detail" placeholder="Detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <button
          className="btn btn-accent"
          disabled={pending}
          onClick={() => {
            if (categoryId === "") return toast.error("Choose a delay reason first.");
            run(
              () => fileDelayBulkAction(unreasonedOverduePlanIds, categoryId, detail || undefined),
              `Delay reason filed on ${unreasonedOverduePlanIds.length} process${unreasonedOverduePlanIds.length === 1 ? "" : "es"}.`,
              onChanged,
            );
            setFiling(false);
            setCategoryId("");
            setDetail("");
          }}
        >
          File
        </button>
        <button className="btn" disabled={pending} onClick={() => setFiling(false)}>Cancel</button>
      </div>
    );
  }

  if (rejecting) {
    return (
      <div style={{ display: "flex", gap: 6, width: "100%" }}>
        <input
          className="ws-detail"
          placeholder="Reason for rejection"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          autoFocus
        />
        <button
          className="btn btn-accent"
          disabled={pending}
          onClick={() => {
            if (!rejectReason.trim()) return toast.error("A reason is required to reject.");
            run(() => rejectAction(governing.planId, rejectReason.trim()), "Rejected — returned to the maker.", onChanged);
            setRejecting(false);
            setRejectReason("");
          }}
        >
          Confirm
        </button>
        <button className="btn" disabled={pending} onClick={() => setRejecting(false)}>Cancel</button>
      </div>
    );
  }

  return (
    <>
      {overdue && (
        <button className="btn" disabled={pending} onClick={() => setFiling(true)}>File reason…</button>
      )}
      {governing.status === "SUBMITTED" && (
        <button className="btn" disabled={pending} onClick={() => setRejecting(true)}>Reject…</button>
      )}
      {governing.status === "NOT_STARTED" && (
        <button className="btn btn-accent" disabled={pending} onClick={() => run(() => startAction(governing.planId), "Started.", onChanged)}>Start stage</button>
      )}
      {governing.status === "IN_PROGRESS" && (
        <button className="btn btn-accent" disabled={pending} onClick={() => run(() => submitAction(governing.planId), "Submitted for QC.", onChanged)}>Submit for QC</button>
      )}
      {governing.status === "SUBMITTED" && (
        <button className="btn btn-accent" disabled={pending} onClick={() => run(() => verifyAction(governing.planId), "Verified — next stage unlocked.", onChanged)}>Verify</button>
      )}
    </>
  );
}
