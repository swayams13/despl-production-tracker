"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { startAction, submitAction, holdAction, resumeAction, verifyAction, rejectAction } from "@/app/actions/process";
import { assignPlanAction } from "@/app/actions/assignment";
import { PageHeader } from "@/components/industrial/page-header";
import { StatusChip } from "@/components/industrial/status-chip";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import type { ActionResult } from "@/app/actions/_action";
import type { StageDetail } from "@/lib/services/stage-detail.read";

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

function fmtDateTime(d: string): string {
  return new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

/** Same shared-hook shape as my-day/_client.tsx, workspace/_client.tsx,
 * admin/_client.tsx and stage-sheet-launcher.tsx — this codebase already
 * tolerates one copy per client component rather than a shared abstraction. */
function useRun(onRefusal: (r: { code: string; message: string } | null) => void) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, ok?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        onRefusal({ code: r.code, message: r.message });
        toast.error(r.message);
      } else {
        onRefusal(null);
        if (ok) toast.success(ok);
        router.refresh();
      }
    });
  return { pending, run };
}

function RefusalNote({ refusal }: { refusal: { code: string; message: string } | null }) {
  if (!refusal) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 8, fontSize: 11 }}>
      <span className="chip c-overdue"><i />{refusal.code}</span>
      <span style={{ color: "var(--muted)" }}>{refusal.message}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "contents" }}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ActivityDetailClient({
  detail,
  actorUserId,
  isQc,
  canAssign,
  members,
}: {
  detail: StageDetail;
  actorUserId: number;
  isQc: boolean;
  canAssign: boolean;
  members: { id: number; name: string }[];
}) {
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  const { pending, run } = useRun(setRefusal);
  const [holdReason, setHoldReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [assigneeId, setAssigneeId] = useState<number | "">("");

  const governing = detail.backingPlans.find((p) => p.isGoverning) ?? detail.backingPlans[0] ?? null;
  const isSelfSubmitted = governing?.submittedBy === actorUserId;

  const reject = () => {
    if (!governing || !rejectReason.trim()) return;
    run(() => rejectAction(governing.planId, rejectReason.trim()), "Rejected — returned to the maker.");
    setRejecting(false);
    setRejectReason("");
  };

  const primaryAction = (() => {
    if (!governing) return null;
    switch (governing.status) {
      case "NOT_STARTED":
        return (
          <button className="btn btn-accent" disabled={pending} onClick={() => run(() => startAction(governing.planId), "Started.")}>
            Start
          </button>
        );
      case "IN_PROGRESS":
        return (
          <button className="btn btn-accent" disabled={pending} onClick={() => run(() => submitAction(governing.planId), "Submitted for QC.")}>
            Submit for QC
          </button>
        );
      case "ON_HOLD":
        return (
          <button className="btn btn-accent" disabled={pending} onClick={() => run(() => resumeAction(governing.planId), "Resumed.")}>
            Resume
          </button>
        );
      case "SUBMITTED":
        if (isQc && !isSelfSubmitted) {
          return (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" disabled={pending} onClick={() => setRejecting(true)}>Reject…</button>
              <button className="btn btn-accent" disabled={pending} onClick={() => run(() => verifyAction(governing.planId), "Verified — next stage unlocked.")}>
                Verify
              </button>
            </div>
          );
        }
        return <span style={{ color: "var(--muted)", fontSize: 12 }}>{isSelfSubmitted ? "Awaiting QC — submitted by you" : "Awaiting QC"}</span>;
      case "COMPLETE":
        return <span style={{ color: "var(--s-complete)", fontSize: 12, fontWeight: 600 }}>Completed</span>;
      default:
        return null;
    }
  })();

  const railContent = (
    <>
      <div className="card">
        <div className="hd"><h3>Schedule</h3></div>
        <div style={{ padding: 16 }}>
          <dl className="sh-kv">
            <Field label="Planned start">{fmtDate(detail.plannedStart)}</Field>
            <Field label="Planned finish">{fmtDate(detail.plannedFinish)}</Field>
            <Field label="Actual start">{fmtDate(detail.actualStart)}</Field>
            <Field label="Actual finish">{fmtDate(detail.actualFinish)}</Field>
            <Field label="Standard duration">{detail.standardDays != null ? `${detail.standardDays}d` : "—"}</Field>
            <Field label="Elapsed">{detail.elapsedDays != null ? `${detail.elapsedDays}d` : "—"}</Field>
            <Field label="Variance">
              {detail.varianceDays != null ? (
                <span className="mono" style={{ color: detail.varianceDays > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
                  {detail.varianceDays > 0 ? "+" : ""}{detail.varianceDays}d
                </span>
              ) : "—"}
            </Field>
          </dl>
        </div>
      </div>

      {detail.holdPoints.length > 0 && (
        <div className="card">
          <div className="hd"><h3>Hold points</h3></div>
          <div style={{ padding: 16, display: "grid", gap: 8 }}>
            {detail.holdPoints.map((h) => (
              <div key={h.qcpItemId} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                <span>{h.srNo} · {h.activity}</span>
                <span style={{ color: h.status === "Cleared" ? "var(--s-complete)" : "var(--s-hold)" }}>{h.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.delayReasons.length > 0 && (
        <div className="card">
          <div className="hd"><h3>Delay reasons</h3></div>
          <div style={{ padding: 16, display: "grid", gap: 10 }}>
            {detail.delayReasons.map((d) => (
              <div key={d.id} style={{ fontSize: 12 }}>
                <div><b>{d.category}</b> · <span style={{ color: "var(--muted)" }}>{fmtDateTime(d.filedAt)}</span></div>
                {d.detail && <div style={{ color: "var(--muted)" }}>{d.detail}</div>}
                <div style={{ color: "var(--muted)" }}>filed by {d.filedByName}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.rejections.length > 0 && (
        <div className="card">
          <div className="hd"><h3>Rejection history</h3></div>
          <div style={{ padding: 16, display: "grid", gap: 10 }}>
            {detail.rejections.map((r, i) => (
              <div key={i} style={{ fontSize: 12 }}>
                <div><span style={{ color: "var(--s-overdue)" }}>Rejected</span> · <span style={{ color: "var(--muted)" }}>{fmtDateTime(r.at)}</span></div>
                {r.reason && <div style={{ color: "var(--muted)" }}>{r.reason}</div>}
                <div style={{ color: "var(--muted)" }}>by {r.actorName ?? "—"}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title={detail.stageName}
        subtitle={
          <>
            {detail.jobNumber} · {detail.serialNo} · {detail.deptName}
          </>
        }
        actions={<StatusChip status={detail.status} />}
      />

      {/* Tablet (<1024px): primary action full-width, 56px min-height, first
          in DOM so it's visible without scrolling (RESPONSIVE_GUIDELINES.md's
          "must never require scrolling to find" rule for this screen by name). */}
      <div className="actd-primary-bar">{primaryAction}</div>

      <div className="grid-2">
        <div>
          <div className="card">
            <div className="hd"><h3>Backing processes</h3></div>
            <div style={{ padding: 16, display: "grid", gap: 10 }}>
              {detail.backingPlans.map((p) => (
                <div key={p.planId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span>{p.processName}{p.isGoverning && <span className="tag" style={{ marginLeft: 8 }}>Governing</span>}</span>
                  <span style={{ color: "var(--muted)" }}>{p.status.replace("_", " ").toLowerCase()}</span>
                </div>
              ))}
            </div>
          </div>

          {governing?.status === "IN_PROGRESS" && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="hd"><h3>Put on hold</h3></div>
              <div style={{ padding: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input className="ws-detail" style={{ maxWidth: 320 }} placeholder="Reason for hold" value={holdReason} onChange={(e) => setHoldReason(e.target.value)} aria-label="Reason for hold" />
                <button
                  className="btn"
                  disabled={pending || !holdReason.trim()}
                  onClick={() => { run(() => holdAction(governing.planId, holdReason.trim()), "Placed on hold."); setHoldReason(""); }}
                >
                  Hold
                </button>
              </div>
            </div>
          )}

          {canAssign && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="hd"><h3>Reassign</h3></div>
              <div style={{ padding: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select className="btn" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value ? Number(e.target.value) : "")} aria-label="Reassign to">
                  <option value="">Choose a member…</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <button
                  className="btn"
                  disabled={pending || assigneeId === "" || !governing}
                  onClick={() => governing && run(() => assignPlanAction(governing.planId, assigneeId as number), "Reassigned.")}
                >
                  Reassign
                </button>
              </div>
            </div>
          )}

          <RefusalNote refusal={refusal} />

          <div className="actd-rail-mobile-only" style={{ marginTop: 14 }}>
            <details>
              <summary className="sh-sec" style={{ cursor: "pointer" }}>Details</summary>
              <div style={{ display: "grid", gap: 12, marginTop: 10 }}>{railContent}</div>
            </details>
          </div>
        </div>

        <div className="actd-rail-desktop-only" style={{ display: "flex", flexDirection: "column", gap: 14 }}>{railContent}</div>
      </div>

      <Modal
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject this activity?"
        footer={
          <ModalConfirmFooter
            onCancel={() => setRejecting(false)}
            onConfirm={reject}
            confirmLabel="Confirm reject"
            destructive
            disabled={pending || !rejectReason.trim()}
          />
        }
      >
        <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 12px" }}>This raises an NCR against {detail.serialNo} · {detail.stageName}.</p>
        <label style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>Reason (required)</label>
        <input className="ws-detail" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} aria-label="Rejection reason" autoFocus />
      </Modal>

      <p className="note" style={{ marginTop: 20 }}>
        <Link href={`/jobs/${detail.jobId}?tab=gantt`} className="sub">← Back to project schedule</Link>
      </p>
    </>
  );
}
