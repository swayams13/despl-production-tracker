"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useStageSheetLauncher, StageSheetLauncher } from "@/components/industrial/stage-sheet-launcher";
import { recordQcpAction } from "@/app/actions/qcp";
import type { QcCockpit } from "@/lib/services/qc-cockpit.read";

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days <= 0) return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function fmtWeek(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

const CHIP: Record<string, string> = {
  Cleared: "c-complete",
  "Awaiting TPI": "c-hold",
  Pending: "c-idle",
  "QC review": "c-submitted",
  Reinspect: "c-overdue",
};

export function QcCockpitClient({ cockpit }: { cockpit: QcCockpit }) {
  const { sheet, openStage, refreshStage, closeSheet } = useStageSheetLauncher();
  const router = useRouter();
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const record = (qcpItemId: number, unitId: number, result: "ACCEPTED" | "REJECTED" | "NA") => {
    start(async () => {
      const r = await recordQcpAction(qcpItemId, unitId, result);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(result === "ACCEPTED" ? "Cleared." : result === "REJECTED" ? "Rejected — flagged for reinspection." : "Marked not applicable.");
        setRecordingKey(null);
        router.refresh();
      }
    });
  };

  const maxRejects = Math.max(1, ...cockpit.rejectsByCheckpoint.map((r) => r.count));

  return (
    <>
      <div className="page-h">
        <h1>QC &amp; Hold Points</h1>
        <span className="sub">Cross-job QC cockpit · everything actionable here</span>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Awaiting your verification</h3>
          <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>{cockpit.queue.length} items · oldest first</span>
        </div>
        {cockpit.queue.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>Nothing awaiting verification.</p>
        ) : (
          <table>
            <thead><tr><th>Job</th><th>Unit</th><th>Process</th><th>Department</th><th>Submitted by</th><th className="num">When</th></tr></thead>
            <tbody>
              {cockpit.queue.map((q) => (
                <tr key={q.planId} className="row" onClick={() => openStage(q.jobId, q.unitId, q.stageNo)} style={{ cursor: "pointer" }}>
                  <td className="mono">{q.jobNumber}</td>
                  <td className="mono" style={{ color: "var(--muted)" }}>{q.serialNo}</td>
                  <td>{q.processName}</td>
                  <td>{q.deptName}</td>
                  <td>{q.submittedByName ?? "—"}</td>
                  <td className="num mono" style={{ color: "var(--muted)" }}>{fmtWhen(q.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Open hold points — QCP / ITP</h3>
          <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>{cockpit.holdPoints.length} open, by age</span>
        </div>
        {cockpit.holdPoints.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>No open hold points.</p>
        ) : (
          [...cockpit.holdPoints]
            .sort((a, b) => b.ageDays - a.ageDays)
            .map((h) => {
              const key = `${h.qcpItemId}:${h.unitId}`;
              return (
                <div className="hp-row" key={key}>
                  <span className="mono" style={{ color: "var(--muted)" }}>{h.srNo}</span>
                  <span className="hclass">{h.classCode}</span>
                  <span
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
                    onClick={() => openStage(h.jobId, h.unitId, h.stageNo)}
                  >
                    {h.activity} · <span className="mono">{h.jobNumber}</span> · Unit {h.serialNo}
                  </span>
                  <span className={`chip ${CHIP[h.status] ?? "c-idle"}`}><i />{h.status}</span>
                  {recordingKey === key ? (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button className="btn" disabled={pending} onClick={() => record(h.qcpItemId, h.unitId, "REJECTED")}>Reject</button>
                      <button className="btn btn-accent" disabled={pending} onClick={() => record(h.qcpItemId, h.unitId, "ACCEPTED")}>Clear</button>
                      <button className="btn" disabled={pending} onClick={() => setRecordingKey(null)}>×</button>
                    </span>
                  ) : (
                    <button className="btn" disabled={pending} onClick={() => setRecordingKey(key)}>Record…</button>
                  )}
                </div>
              );
            })
        )}
      </div>

      <div className="grid-h">
        <div className="card">
          <div className="hd"><h3>First-pass yield — 6 weeks</h3></div>
          <div style={{ padding: "16px 12px 10px" }}>
            <div className="bars">
              {cockpit.yieldTrend.map((w, i) => (
                <div className="b" key={i}>
                  <i style={{ height: w.yieldPct != null ? `${w.yieldPct}%` : "2%", background: w.yieldPct == null ? "var(--s-idle)" : undefined }} title={w.yieldPct != null ? `${w.yieldPct}% first-pass yield` : "No submissions"} />
                  <span>{w.yieldPct != null ? `${w.yieldPct}%` : "—"}</span>
                  <span style={{ fontSize: 9 }}>{fmtWeek(w.weekStart)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="hd"><h3>Rejects by checkpoint</h3></div>
          {cockpit.rejectsByCheckpoint.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No rejected checkpoints recorded.</p>
          ) : (
            <div style={{ padding: "8px 0" }}>
              {cockpit.rejectsByCheckpoint.map((r) => (
                <div className="gbar-row" key={r.activity}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.activity}</span>
                  <div className="gbar">
                    <i style={{ width: `${(r.count / maxRejects) * 100}%`, background: "var(--s-overdue)", opacity: 0.7 }} />
                  </div>
                  <span className="mono num">{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <StageSheetLauncher sheet={sheet} onOpenChange={closeSheet} onChanged={refreshStage} />
    </>
  );
}
