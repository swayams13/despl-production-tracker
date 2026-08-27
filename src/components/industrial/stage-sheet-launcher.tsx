"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StageSheet } from "./stage-sheet";
import { StatusChip } from "./status-chip";
import { startAction, submitAction, verifyAction, rejectAction } from "@/app/actions/process";
import { fileDelayBulkAction } from "@/app/actions/delay";
import { nudgeQcAction } from "@/app/actions/notifications";
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
  // Phone reason-grid selection — lifted here (not local to ExecPhoneBody)
  // because the grid (body slot) and "File reason & start" (footer slot)
  // are rendered as SIBLING props, not nested components.
  const [reasonCategoryId, setReasonCategoryId] = useState<number | "">("");
  const [reasonDetail, setReasonDetail] = useState("");

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
          <div className="sh-body-phone">
            <ExecPhoneBody
              detail={d}
              governing={governing}
              overdueReasonPending={overdueReasonPending}
              categories={d.delayCategories}
              categoryId={reasonCategoryId}
              setCategoryId={setReasonCategoryId}
              detailText={reasonDetail}
              setDetailText={setReasonDetail}
            />
          </div>
          <div className="sh-body-desktop">
          {d.backingPlans.length > 1 ? (
            <>
              <div className="sh-sec">Backing processes ({d.backingPlans.length})</div>
              {d.backingPlans.map((p) => (
                <BackingPlanRow key={p.planId} plan={p} pending={pending} run={run} onChanged={onChanged} />
              ))}
            </>
          ) : (
            d.backingPlans[0]?.contributingOps.length ? (
              <>
                <div className="sh-sec">Contributing operations ({d.backingPlans[0].contributingOps.length})</div>
                {d.backingPlans[0].contributingOps.map((o, i) => (
                  <div key={i} className="hp-row" style={{ gridTemplateColumns: "auto 1fr auto", padding: "6px 0" }}>
                    <span className="mono" style={{ color: "var(--muted)", fontSize: 10.5, textTransform: "uppercase" }}>{o.source}</span>
                    <span>{o.label}</span>
                    <StatusChip status={o.status === "COMPLETE" ? "complete" : o.status === "SUBMITTED" ? "submitted" : o.status === "IN_PROGRESS" ? "progress" : "idle"} />
                  </div>
                ))}
              </>
            ) : null
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
          </div>
        </>
      }
      footer={
        governing && (
          <>
            <div className="sh-ft-phone">
              <ExecPhoneFooter
                detail={d}
                governing={governing}
                overdueReasonPending={overdueReasonPending}
                categoryId={reasonCategoryId}
                detailText={reasonDetail}
                resetReason={() => { setReasonCategoryId(""); setReasonDetail(""); }}
                pending={pending}
                run={run}
                onChanged={onChanged}
              />
            </div>
            <div className="sh-ft-desktop">
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
            </div>
          </>
        )
      }
    />
  );
}

type Category = { id: number; name: string };

// ── Full-screen execution sheet body (<640px, R2 Task 2,
// SPEC-supervisor-ui-v3.md §4 P3-05..08). Four states, all built from real
// StageDetail fields — no invented ITP references, "raised by" names, or a
// hold-trail timeline (stage-detail.read.ts's holdPoints only ever carries
// srNo/activity/classCode/status/ageDays, confirmed before writing this).
// Photo evidence (P3-06's camera/geotag section) is deliberately omitted —
// R4 scope, blocked on the D20 object-storage decision, out of R2's own
// stated global constraint. ─────────────────────────────────────────────
function ExecPhoneBody({
  detail: d,
  governing,
  overdueReasonPending,
  categories,
  categoryId,
  setCategoryId,
  detailText,
  setDetailText,
}: {
  detail: StageDetail;
  governing: StageBackingPlan | null;
  overdueReasonPending: boolean;
  categories: Category[];
  categoryId: number | "";
  setCategoryId: (v: number | "") => void;
  detailText: string;
  setDetailText: (v: string) => void;
}) {
  if (overdueReasonPending) {
    return (
      <>
        <div className="sh-phone-banner c-overdue">
          Due {fmtDate(d.plannedFinish)}, started nothing yet. <b>Pick why it is late</b> — that files the delay and starts the job in one go.
        </div>
        <div className="sh-sec">Why is it late?</div>
        <div className="reason-grid">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`reason-cell${categoryId === c.id ? " sel" : ""}`}
              onClick={() => setCategoryId(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="sh-sec">Detail (optional)</div>
        <textarea
          className="ws-detail"
          style={{ width: "100%", minHeight: 56, resize: "vertical" }}
          placeholder="Add detail…"
          value={detailText}
          onChange={(e) => setDetailText(e.target.value)}
        />
      </>
    );
  }

  if (governing?.status === "ON_HOLD") {
    const openHold = d.holdPoints.find((h) => h.status !== "Cleared") ?? null;
    return (
      <>
        <div className="sh-phone-banner c-hold">
          <b>Held{openHold ? ` — ${openHold.activity}` : ""}</b>
          <div>You cannot finish this operation until the hold point is cleared. Nothing you do here is lost.</div>
        </div>
        {openHold && (
          <div className="sh-hold-card">
            <div><span className="mono">{openHold.srNo}</span> · {openHold.classCode}</div>
            <div className="age">{openHold.ageDays}d</div>
            <div className="sub">held</div>
          </div>
        )}
      </>
    );
  }

  if (governing?.status === "SUBMITTED") {
    return (
      <div className="sh-phone-banner c-submitted">
        <b>Submitted{governing.actualFinish ? ` ${fmtDate(governing.actualFinish)}` : ""} — waiting for QC</b>
        <div>You recorded this work, so you cannot verify it. QC checks it and marks it done — that separation is the record&apos;s value.</div>
      </div>
    );
  }

  // IN_PROGRESS / NOT_STARTED (not overdue): a short status line — no
  // photo/geo capture here, see the comment above. Deliberately doesn't
  // claim "Ready to start" for NOT_STARTED — a gating-blocked predecessor
  // is a real possibility stage-detail.read.ts's StageBackingPlan doesn't
  // expose here, and the footer's "Start" button (below) already surfaces
  // that refusal for real if it happens, matching the desktop sheet's own
  // existing behavior (always show Start, let the server refuse).
  return (
    <p className="note" style={{ margin: "16px 0", textAlign: "left" }}>
      {governing?.status === "IN_PROGRESS" ? "In progress." : "Not started."}
    </p>
  );
}

// ── Full-screen execution sheet footer — one primary action, 56px,
// pinned to the bottom (CSS, see globals.css .sh-ft-phone). ──────────────
function ExecPhoneFooter({
  detail: d,
  governing,
  overdueReasonPending,
  categoryId,
  detailText,
  resetReason,
  pending,
  run,
  onChanged,
}: {
  detail: StageDetail;
  governing: StageBackingPlan | null;
  overdueReasonPending: boolean;
  categoryId: number | "";
  detailText: string;
  resetReason: () => void;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok: string, after?: () => void) => void;
  onChanged: () => void;
}) {
  if (!governing) return null;

  if (overdueReasonPending) {
    const fileAndStart = () => {
      run(
        async () => {
          const filed = await fileDelayBulkAction([governing.planId], categoryId as number, detailText || undefined);
          if (!filed.ok) return filed;
          return startAction(governing.planId); // may itself refuse (gating) — §6(b)'s legitimate partial success; the reason still filed, re-fetch shows it
        },
        "Filed & started.",
        () => { resetReason(); onChanged(); },
      );
    };
    return (
      <button className="btn btn-accent" style={{ width: "100%" }} disabled={pending || categoryId === ""} onClick={fileAndStart}>
        {categoryId === "" ? "Pick a reason to start" : "File reason & start"}
      </button>
    );
  }

  if (governing.status === "ON_HOLD") {
    const openHold = d.holdPoints.find((h) => h.status !== "Cleared") ?? null;
    return (
      <div style={{ display: "flex", gap: 8, width: "100%" }}>
        <button className="btn" style={{ flex: 1 }} disabled>Finish — held</button>
        <NudgeQcButton planId={governing.planId} ageDays={openHold?.ageDays ?? 0} pending={pending} onChanged={onChanged} />
      </div>
    );
  }

  if (governing.status === "SUBMITTED") return null; // read-only — verify/reject stay on the queue card (Task 1), not duplicated here

  if (governing.status === "NOT_STARTED")
    return <button className="btn btn-accent" style={{ width: "100%" }} disabled={pending} onClick={() => run(() => startAction(governing.planId), "Started.", onChanged)}>Start</button>;

  if (governing.status === "IN_PROGRESS")
    return <button className="btn btn-accent" style={{ width: "100%" }} disabled={pending} onClick={() => run(() => submitAction(governing.planId), "Submitted for QC.", onChanged)}>Submit finish</button>;

  return null;
}

// ── Nudge QC (D32) — its own local pending state so a cooldown refusal
// (NUDGE_COOLDOWN, thrown by the server, never a client timer) disables the
// button without touching the sheet's shared `run`/`pending`. ────────────
function NudgeQcButton({ planId, ageDays, pending, onChanged }: { planId: number; ageDays: number; pending: boolean; onChanged: () => void }) {
  const [nudging, startNudge] = useTransition();
  const [nudged, setNudged] = useState(false);
  const nudge = () =>
    startNudge(async () => {
      const r = await nudgeQcAction(planId, ageDays);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success("QC nudged.");
        setNudged(true);
        onChanged();
      }
    });
  return (
    <button className="btn btn-outline-accent" style={{ flex: 1 }} disabled={pending || nudging || nudged} onClick={nudge}>
      {nudged ? "Nudged" : "Nudge QC"}
    </button>
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
  const opsComplete = plan.contributingOps.filter((o) => o.status === "COMPLETE").length;
  const opsTotal = plan.contributingOps.length;
  return (
    <div style={{ padding: "8px 0" }}>
      <div className="hp-row" style={{ gridTemplateColumns: "1fr auto auto" }}>
        <span>{plan.processName}{plan.isGoverning && <span style={{ color: "var(--muted)" }}> (governing)</span>}</span>
        <StatusChip status={statusMap[plan.status] ?? "idle"} />
        {plan.status === "NOT_STARTED" && (
          <button className="btn" disabled={pending} onClick={() => run(() => startAction(plan.planId), "Started.", onChanged)}>Start</button>
        )}
        {plan.status === "IN_PROGRESS" && (
          <button className="btn" disabled={pending} onClick={() => run(() => submitAction(plan.planId), "Submitted for QC.", onChanged)}>Submit</button>
        )}
      </div>
      {opsTotal > 0 && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
          {opsComplete}/{opsTotal} fabrication/assembly operations complete
          {opsComplete < opsTotal &&
            ` — waiting on ${plan.contributingOps
              .filter((o) => o.status !== "COMPLETE")
              .map((o) => o.label)
              .join(", ")}`}
        </div>
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
