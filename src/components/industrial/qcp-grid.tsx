"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { recordQcpAction, approveQcpWaiverAction } from "@/app/actions/qcp";
import type { QcpGrid as QcpGridData, QcpGridRow } from "@/lib/services/qcp-grid.read";

const CHIP: Record<string, string> = {
  Cleared: "c-complete",
  "Awaiting TPI": "c-hold",
  Pending: "c-idle",
  "QC review": "c-submitted",
  Reinspect: "c-overdue",
  "Pending waiver": "c-hold",
};

export function QcpGrid({ jobId, data, canApproveWaiver }: { jobId: number; data: QcpGridData; canApproveWaiver: boolean }) {
  const router = useRouter();
  const [recordingId, setRecordingId] = useState<number | null>(null);
  const [pending, start] = useTransition();

  if (data.units.length === 0) {
    return <p className="note" style={{ margin: "16px 0" }}>No units on this job yet.</p>;
  }

  const record = (qcpItemId: number, result: "ACCEPTED" | "REJECTED" | "NA") => {
    start(async () => {
      const r = await recordQcpAction(qcpItemId, data.unitId, result);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(result === "ACCEPTED" ? "Cleared." : result === "REJECTED" ? "Rejected — flagged for reinspection." : "Marked not applicable.");
        setRecordingId(null);
        router.refresh();
      }
    });
  };

  const approveWaiver = (qcpItemId: number) => {
    start(async () => {
      const r = await approveQcpWaiverAction(qcpItemId, data.unitId);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success("Waiver approved — hold point cleared.");
        router.refresh();
      }
    });
  };

  return (
    <div className="card">
      <div className="hd">
        <h3>QCP / ITP — {data.serialNo ? `Unit ${data.serialNo}` : "—"}</h3>
        <div className="legend">
          <span><span className="hclass" style={{ display: "inline-flex" }}>H</span>Hold</span>
          <span><span className="hclass" style={{ display: "inline-flex" }}>W</span>Witness</span>
          <span><span className="hclass" style={{ display: "inline-flex" }}>R</span>Review</span>
        </div>
        <select
          className="btn"
          style={{ marginLeft: 8 }}
          value={data.unitId}
          onChange={(e) => router.push(`/jobs/${jobId}?tab=qcp&unit=${e.target.value}`)}
          aria-label="Unit"
        >
          {data.units.map((u) => <option key={u.id} value={u.id}>Unit {u.serialNo}</option>)}
        </select>
        <a className="btn" style={{ marginLeft: 8 }} href={`/api/jobs/${jobId}/qcp/export?unit=${data.unitId}`}>Download (Excel)</a>
      </div>
      {data.sections.length === 0 ? (
        <p className="note" style={{ margin: "16px 0" }}>No QCP template for this job.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Ref</th><th>Activity</th><th>Class</th><th>Acceptance ref</th><th>QC</th><th>TPI</th><th>Status</th><th className="num">Age</th><th />
            </tr>
          </thead>
          <tbody>
            {data.sections.map((sec) => (
              <QcpSectionRows
                key={sec.section}
                sec={sec}
                recordingId={recordingId}
                setRecordingId={setRecordingId}
                onRecord={record}
                onApproveWaiver={approveWaiver}
                canApproveWaiver={canApproveWaiver}
                pending={pending}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function QcpSectionRows({
  sec,
  recordingId,
  setRecordingId,
  onRecord,
  onApproveWaiver,
  canApproveWaiver,
  pending,
}: {
  sec: QcpGridData["sections"][number];
  recordingId: number | null;
  setRecordingId: (id: number | null) => void;
  onRecord: (qcpItemId: number, result: "ACCEPTED" | "REJECTED" | "NA") => void;
  onApproveWaiver: (qcpItemId: number) => void;
  canApproveWaiver: boolean;
  pending: boolean;
}) {
  return (
    <>
      <tr>
        <td colSpan={9} style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".5px", color: "var(--muted)", background: "var(--surface-2)", fontWeight: 600 }}>
          {sec.title}
        </td>
      </tr>
      {sec.rows.map((row) => (
        <QcpRow
          key={row.qcpItemId}
          row={row}
          recording={recordingId === row.qcpItemId}
          setRecording={setRecordingId}
          onRecord={onRecord}
          onApproveWaiver={onApproveWaiver}
          canApproveWaiver={canApproveWaiver}
          pending={pending}
        />
      ))}
    </>
  );
}

function QcpRow({
  row,
  recording,
  setRecording,
  onRecord,
  onApproveWaiver,
  canApproveWaiver,
  pending,
}: {
  row: QcpGridRow;
  recording: boolean;
  setRecording: (id: number | null) => void;
  onRecord: (qcpItemId: number, result: "ACCEPTED" | "REJECTED" | "NA") => void;
  onApproveWaiver: (qcpItemId: number) => void;
  canApproveWaiver: boolean;
  pending: boolean;
}) {
  const actionable = row.status !== "Cleared" && !row.pendingWaiver;
  // AUD-003: a Production Head/Admin sign-off, not the QC Reject/Clear pair —
  // only offered on a checkpoint that is actually sitting in the pending-NA
  // state, and only to a role that can call approveQcpWaiver server-side.
  const showApproveWaiver = row.pendingWaiver && canApproveWaiver;
  return (
    <tr className="row">
      <td className="mono" style={{ color: "var(--muted)" }}>{row.srNo}</td>
      <td>{row.activity}</td>
      <td><span className="hclass">{row.classCode}</span></td>
      <td className="mono" style={{ color: "var(--muted)", fontSize: 11.5 }}>{row.acceptanceCriteria ?? "—"}</td>
      <td>{row.qcCode ?? "—"}</td>
      <td>{row.tpiCode ?? "—"}</td>
      <td><span className={`chip ${CHIP[row.status] ?? "c-idle"}`}><i />{row.status}</span></td>
      <td className="num mono" style={{ color: row.ageDays > 3 ? "var(--s-overdue)" : "var(--muted)" }}>{row.ageDays > 0 ? `${row.ageDays}d` : "—"}</td>
      <td className="num">
        {showApproveWaiver && (
          <button className="btn btn-accent" disabled={pending} onClick={() => onApproveWaiver(row.qcpItemId)}>Approve waiver</button>
        )}
        {actionable && (
          recording ? (
            <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
              <button className="btn" disabled={pending} onClick={() => onRecord(row.qcpItemId, "REJECTED")}>Reject</button>
              <button className="btn btn-accent" disabled={pending} onClick={() => onRecord(row.qcpItemId, "ACCEPTED")}>Clear</button>
              <button className="btn" disabled={pending} onClick={() => setRecording(null)}>×</button>
            </span>
          ) : (
            <button className="btn" disabled={pending} onClick={() => setRecording(row.qcpItemId)}>Record…</button>
          )
        )}
      </td>
    </tr>
  );
}
