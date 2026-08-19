import { StatusChip } from "./status-chip";
import type { ClientStatus, ClientJobView, ClientUnitRow } from "@/lib/services/client-snapshot.read";
import type { StageDisplayStatus } from "./stage-status";
import type { ReactNode } from "react";

/** Client-facing label, overriding <StatusChip>'s internal default (spec §7/§8). */
const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  complete: "Complete",
  progress: "On track",
  hold: "Under inspection",
  overdue: "Delayed",
  idle: "Not started",
};

/** ClientStatus is a subset of StageDisplayStatus by construction (see toClientStatus) — safe 1:1 pass-through for the chip's icon. */
function chipStatus(status: ClientStatus): StageDisplayStatus {
  return status;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function JobSection({ job }: { job: ClientJobView }) {
  if (!job.hasUpdate) {
    return (
      <section className="rt-card" style={{ marginBottom: 16 }}>
        <div className="rt-card-top">
          <b className="mono">{job.jobNumber}</b>
          <span className="sub">{job.equipmentName ?? "—"}</span>
        </div>
        <p className="note" style={{ margin: "8px 0 0" }}>
          Your update will appear here once it&apos;s confirmed.
        </p>
      </section>
    );
  }

  return (
    <section className="rt-card" style={{ marginBottom: 16 }}>
      <div className="rt-card-top">
        <b className="mono">{job.jobNumber}</b>
        <span className="sub">{job.equipmentName ?? "—"}</span>
        <span className="sub" style={{ marginLeft: "auto" }}>
          As of {fmtDate(job.asOf)}
        </span>
      </div>
      <div className="rt-card-row">
        <span>Overall</span>
        <b className="mono">{job.overallPct}%</b>
      </div>
      {job.forecastDispatch && (
        <div className="rt-card-row">
          <span>Forecast dispatch</span>
          <b className="mono">{fmtDate(job.forecastDispatch)}</b>
        </div>
      )}
      <table style={{ width: "100%", marginTop: 12 }}>
        <thead>
          <tr>
            <th>Unit</th>
            <th>Stage</th>
            <th>Status</th>
            <th className="num">Complete</th>
          </tr>
        </thead>
        <tbody>
          {job.units.map((u: ClientUnitRow) => (
            <tr key={u.serialNo}>
              <td className="mono">{u.serialNo}</td>
              <td>{u.stageName}</td>
              <td>
                <StatusChip status={chipStatus(u.status)} label={CLIENT_STATUS_LABEL[u.status]} />
              </td>
              <td className="num mono">{u.percentComplete}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ClientPortalView({ jobs, reviewBanner }: { jobs: ClientJobView[]; reviewBanner?: ReactNode }) {
  if (jobs.length === 0) {
    return <p className="note">No orders on record yet.</p>;
  }
  return (
    <div>
      {reviewBanner}
      {jobs.map((job) => (
        <JobSection key={job.jobId} job={job} />
      ))}
    </div>
  );
}
