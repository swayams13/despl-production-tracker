"use client";

import { useState, useTransition, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useStageSheetLauncher, StageSheetLauncher } from "@/components/industrial/stage-sheet-launcher";
import { ResponsiveTable } from "@/components/industrial/responsive-table";
import { PageHeader } from "@/components/industrial/page-header";
import { clickableRowProps } from "@/components/industrial/data-table";
import { recordQcpAction } from "@/app/actions/qcp";
import { dispositionNcrAction } from "@/app/actions/ncr";
import type { ActionResult } from "@/app/actions/_action";
import type { QcCockpit, QcQueueRow, OpenNcrRow } from "@/lib/services/qc-cockpit.read";

type Refusal = { code: string; message: string };
type NcrDisposition = "USE_AS_IS" | "REPAIR" | "REWORK" | "SCRAP" | "CONCESSION";
const REWORK_DISPOSITIONS: NcrDisposition[] = ["REWORK", "REPAIR"];

function stop(e: MouseEvent) {
  e.stopPropagation();
}

/** Same inline-refusal pattern as packing-panel.tsx / dispatch-panel.tsx — never toast-only. */
function RefusalNote({ refusal }: { refusal: Refusal | null }) {
  if (!refusal) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6, fontSize: 11 }} onClick={stop}>
      <span className="chip c-overdue"><i />{refusal.code}</span>
      <span style={{ color: "var(--muted)", flex: "1 1 160px" }}>{refusal.message}</span>
    </div>
  );
}

/**
 * Inline disposition form for one OPEN Ncr. All five dispositions are legal
 * from OPEN (ncr.service.ts's NCR_TRANSITIONS) — REWORK/REPAIR route to
 * REWORK_IN_PROGRESS, the other three to DISPOSITIONED; the service decides
 * which, this form just collects the value.
 *
 * reworkDueDate is surfaced only for REWORK/REPAIR — it's meaningless for a
 * disposition that sends no work back to the floor. reworkOwnerId (schema/
 * service already support it) has no picker here — no user-search component
 * exists yet in this codebase; add one when someone asks to assign a named
 * rework owner instead of just a due date.
 */
function DispositionForm({
  row,
  pending,
  start,
  onDone,
  onCancel,
}: {
  row: OpenNcrRow;
  pending: boolean;
  start: (fn: () => Promise<void>) => void;
  onDone: (r: ActionResult | null) => void;
  onCancel: () => void;
}) {
  const [disposition, setDisposition] = useState<NcrDisposition>("REWORK");
  const [notes, setNotes] = useState("");
  const [reworkDueDate, setReworkDueDate] = useState("");

  const save = () => {
    start(async () => {
      const r = await dispositionNcrAction(row.ncrId, disposition, {
        notes: notes.trim() || undefined,
        reworkDueDate:
          REWORK_DISPOSITIONS.includes(disposition) && reworkDueDate ? new Date(reworkDueDate) : undefined,
      });
      onDone(r);
    });
  };

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }} onClick={stop}>
      <select className="ws-detail" value={disposition} onChange={(e) => setDisposition(e.target.value as NcrDisposition)}>
        <option value="REWORK">Rework</option>
        <option value="REPAIR">Repair</option>
        <option value="USE_AS_IS">Use as-is</option>
        <option value="CONCESSION">Concession</option>
        <option value="SCRAP">Scrap</option>
      </select>
      {REWORK_DISPOSITIONS.includes(disposition) && (
        <input
          type="date"
          className="ws-detail"
          value={reworkDueDate}
          onChange={(e) => setReworkDueDate(e.target.value)}
          style={{ width: 140 }}
          aria-label="Rework due date"
        />
      )}
      <input
        className="ws-detail"
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        style={{ flex: "1 1 200px" }}
      />
      <button className="btn btn-accent" disabled={pending} onClick={save}>
        Save disposition
      </button>
      <button className="btn" disabled={pending} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

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

/** `<ResponsiveTable />`'s card counterpart to "Awaiting your verification"'s
 * 6-column table — same open-stage-sheet onClick as the table row. */
function QueueRowCard({ row, onOpen }: { row: QcQueueRow; onOpen: () => void }) {
  return (
    <div className="rt-card" {...clickableRowProps(onOpen)}>
      <div className="rt-card-top">
        <b className="mono">{row.jobNumber}</b>
        <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>{row.serialNo}</span>
      </div>
      <div className="rt-card-meta">{row.processName} · {row.deptName}</div>
      <div className="rt-card-row">
        <span>{row.submittedByName ?? "—"}</span>
        <span className="mono">{fmtWhen(row.submittedAt)}</span>
      </div>
    </div>
  );
}

export function QcCockpitClient({ cockpit }: { cockpit: QcCockpit }) {
  const { sheet, openStage, refreshStage, closeSheet } = useStageSheetLauncher();
  const router = useRouter();
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [dispositioningId, setDispositioningId] = useState<number | null>(null);
  const [dispositionPending, startDisposition] = useTransition();
  const [refusal, setRefusal] = useState<Refusal | null>(null);

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

  const onDispositionResult = (r: ActionResult | null) => {
    if (!r || !r.ok) {
      setRefusal(r ? { code: r.code, message: r.message } : null);
      if (r) toast.error(r.message);
      return;
    }
    setRefusal(null);
    setDispositioningId(null);
    toast.success("Disposition recorded.");
    router.refresh();
  };

  const maxRejects = Math.max(1, ...cockpit.rejectsByCheckpoint.map((r) => r.count));

  return (
    <>
      <PageHeader title="QC & Hold Points" subtitle="Cross-job QC cockpit · everything actionable here" />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Awaiting your verification</h3>
          <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>{cockpit.queue.length} items · oldest first</span>
        </div>
        {cockpit.queue.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>Nothing awaiting verification.</p>
        ) : (
          <ResponsiveTable
            table={
              <table>
                <thead><tr><th>Job</th><th>Unit</th><th>Process</th><th>Department</th><th>Submitted by</th><th className="num">When</th></tr></thead>
                <tbody>
                  {cockpit.queue.map((q) => (
                    <tr key={q.planId} className="row" {...clickableRowProps(() => openStage(q.jobId, q.unitId, q.stageNo))}>
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
            }
            cards={cockpit.queue.map((q) => (
              <QueueRowCard key={q.planId} row={q} onOpen={() => openStage(q.jobId, q.unitId, q.stageNo)} />
            ))}
          />
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
                    {...clickableRowProps(() => openStage(h.jobId, h.unitId, h.stageNo))}
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
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

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>NCRs awaiting disposition</h3>
          <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>
            {cockpit.openNcrs.length} open · {cockpit.rework.openCount} total in rework/disposition ·{" "}
            {cockpit.rework.totalReworkHours}h avg rework closed
          </span>
        </div>
        {cockpit.openNcrs.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>Nothing awaiting disposition.</p>
        ) : (
          cockpit.openNcrs.map((n) => (
            <div
              key={n.ncrId}
              style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: "1px solid var(--border)", fontSize: 12 }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {n.entityLabel} · <span className="mono">{n.jobNumber}</span>
                {n.serialNo ? ` · Unit ${n.serialNo}` : ""}
              </span>
              <span className="chip c-overdue"><i />{n.categoryName}</span>
              <span style={{ color: "var(--muted)", fontSize: 11 }}>
                {n.rejectionDetail ?? "—"} · rejected by {n.rejectedByName}
              </span>
              {dispositioningId === n.ncrId ? (
                <DispositionForm
                  row={n}
                  pending={dispositionPending}
                  start={startDisposition}
                  onDone={onDispositionResult}
                  onCancel={() => {
                    setDispositioningId(null);
                    setRefusal(null);
                  }}
                />
              ) : (
                <button className="btn" disabled={dispositionPending} onClick={() => setDispositioningId(n.ncrId)}>
                  Disposition…
                </button>
              )}
              {dispositioningId === n.ncrId && <RefusalNote refusal={refusal} />}
            </div>
          ))
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
                  <span>{fmtWeek(w.weekStart)}</span>
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
