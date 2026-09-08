"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StageSpine } from "@/components/industrial/stage-spine";
import { PageHeader } from "@/components/industrial/page-header";
import { clickableRowProps } from "@/components/industrial/data-table";
import { sendDigestAction } from "@/app/actions/reports";
import type { DailyDigest, DigestHistoryEntry } from "@/lib/services/reports.read";

function fmtDate(date: string): string {
  return new Date(`${date}T00:00:00+05:30`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function ReportsClient({
  digest,
  history,
  canSend,
}: {
  digest: DailyDigest;
  history: DigestHistoryEntry[];
  canSend: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const alreadySent = history.some((h) => h.date === digest.date);

  const changeDate = (value: string) => router.push(`/reports?date=${value}`);

  const send = () => {
    start(async () => {
      const r = await sendDigestAction(digest.date);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(r.recipients ? `Sent to ${r.recipients} management user${r.recipients === 1 ? "" : "s"}.` : "Sent.");
        router.refresh();
      }
    });
  };

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Daily digest — generated from real events, never static"
        actions={
          <>
            <input
              type="date"
              className="btn"
              value={digest.date}
              max={new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)}
              onChange={(e) => e.target.value && changeDate(e.target.value)}
              aria-label="Digest date"
            />
            {canSend && (
              <button className="btn btn-accent" disabled={pending || alreadySent} onClick={send}>
                {alreadySent ? "Sent" : "Send now"}
              </button>
            )}
          </>
        }
      />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>{fmtDate(digest.date)}</h3>
          <span className="sub" style={{ marginLeft: "auto" }}>
            {digest.holdsOpened} hold point{digest.holdsOpened === 1 ? "" : "s"} opened · {digest.holdsCleared} cleared
          </span>
        </div>
        {digest.jobs.length === 0 ? (
          <p className="note" style={{ padding: "0 16px 14px" }}>No jobs in this tenant yet.</p>
        ) : (
          digest.jobs.map((j) => (
            <div key={j.jobId} className="hp-row" style={{ gridTemplateColumns: "1fr auto", padding: "12px 16px", alignItems: "center" }}>
              <div>
                <div>
                  <b className="mono">{j.jobNumber}</b> — {j.familyName}
                  {" · "}
                  {j.stagesVerifiedToday} stage{j.stagesVerifiedToday === 1 ? "" : "s"} verified
                  {j.newOverdueCount > 0 && (
                    <span style={{ color: "var(--s-overdue)" }}>
                      {" · "}
                      {j.newOverdueCount} new overdue
                      {j.newOverdueReasons.length > 0 && ` (${j.newOverdueReasons.join(", ")})`}
                    </span>
                  )}
                </div>
                {j.spine.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <StageSpine variant="mini" segments={j.spine} />
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="grid-h" style={{ marginTop: 0 }}>
        <div className="card">
          <div className="hd">
            <h3>Tomorrow&rsquo;s due list</h3>
          </div>
          {digest.tomorrowDue.length === 0 ? (
            <p className="note" style={{ padding: "0 16px 14px" }}>Nothing due tomorrow.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Unit</th>
                  <th>Process</th>
                </tr>
              </thead>
              <tbody>
                {digest.tomorrowDue.map((d, i) => (
                  <tr className="row" key={i}>
                    <td className="mono">{d.jobNumber}</td>
                    <td>{d.unitLabel}</td>
                    <td>{d.processName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="hd">
            <h3>History</h3>
          </div>
          {history.length === 0 ? (
            <p className="note" style={{ padding: "0 16px 14px" }}>No digest has been sent yet.</p>
          ) : (
            history.map((h) => (
              <div
                className="d-row"
                key={h.date}
                {...clickableRowProps(() => changeDate(h.date))}
                style={{ cursor: "pointer", padding: "10px 16px" }}
              >
                {fmtDate(h.date)}
                <small>Sent {new Date(h.sentAt).toLocaleString("en-IN")}</small>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
