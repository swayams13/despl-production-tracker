"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StageSheet } from "./stage-sheet";
import { StatusChip } from "./status-chip";
import { startAction, submitAction, verifyAction, rejectAction } from "@/app/actions/process";
import { fileDelayBulkAction } from "@/app/actions/delay";
import type { ActionResult } from "@/app/actions/_action";
import type { StageDetail, StageBackingPlan } from "@/lib/services/stage-detail.read";

/**
 * The real `<StageSheet>` wiring (fetch stage detail, role-correct actions,
 * delay-reason filing, reject) — extracted out of job-detail's `_client.tsx`
 * (§9.5) so `/qc` and `/departments/[id]` (§9.7) can open the exact same
 * sheet from a cross-job row without duplicating ~300 lines of gating-
 * sensitive UI. Any page that can name a (jobId, unitId, stageNo) triple can
 * use this — the sheet itself is job-agnostic, it just needs telling which
 * job's `/api/jobs/:id/stage` endpoint to call per open.
 */
export interface StageSheetState {
  open: boolean;
  loading: boolean;
  jobId: number | null;
  detail: StageDetail | null;
}

export function useStageSheetLauncher() {
  const [sheet, setSheet] = useState<StageSheetState>({ open: false, loading: false, jobId: null, detail: null });
  const router = useRouter();

  const openStage = async (jobId: number, unitId: number | undefined, stageNo: number) => {
    if (unitId == null) return;
    setSheet({ open: true, loading: true, jobId, detail: null });
    try {
      const res = await fetch(`/api/jobs/${jobId}/stage?unit=${unitId}&stage=${stageNo}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Could not load that stage.");
        setSheet({ open: false, loading: false, jobId: null, detail: null });
        return;
      }
      const detail: StageDetail = await res.json();
      setSheet({ open: true, loading: false, jobId, detail });
    } catch {
      toast.error("Could not load that stage.");
      setSheet({ open: false, loading: false, jobId: null, detail: null });
    }
  };

  const refreshStage = async () => {
    if (!sheet.detail || sheet.jobId == null) return;
    const res = await fetch(`/api/jobs/${sheet.jobId}/stage?unit=${sheet.detail.unitId}&stage=${sheet.detail.stageNo}`);
    if (res.ok) {
      const detail: StageDetail = await res.json();
      setSheet((s) => ({ ...s, detail }));
    }
    router.refresh();
  };

  const closeSheet = (open: boolean) => setSheet((s) => ({ ...s, open }));

  return { sheet, openStage, refreshStage, closeSheet };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
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

export function StageSheetLauncher({
  sheet,
  onOpenChange,
  onChanged,
}: {
  sheet: StageSheetState;
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
