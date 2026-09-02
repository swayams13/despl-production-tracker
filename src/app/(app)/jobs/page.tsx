import Link from "next/link";
import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadJobs } from "@/lib/services/jobs.read";
import { StageSpine } from "@/components/industrial/stage-spine";
import { JobRow } from "./_row";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return fmtDate(iso);
}

export default async function JobsList() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const jobs = await loadJobs(actor);
  const canCreate = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return (
    <>
      <div className="page-h">
        <h1>Jobs</h1>
        <span className="sub">{jobs.length} job{jobs.length === 1 ? "" : "s"}</span>
        {canCreate && (
          <Link href="/jobs/new" className="btn btn-accent" style={{ marginLeft: "auto" }}>+ New job</Link>
        )}
      </div>

      {jobs.length === 0 ? (
        <p className="note">
          No jobs yet.{canCreate && <> <Link href="/jobs/new">Create the first one →</Link></>}
        </p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Family</th>
                <th>Description</th>
                <th className="num">Units</th>
                <th style={{ minWidth: 160 }}>Stages</th>
                <th style={{ minWidth: 140 }}>% complete</th>
                <th>Forecast vs due</th>
                <th className="num">Open holds</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <JobRow key={j.id} jobId={j.id}>
                  <td>
                    <span className="mono" style={{ color: "var(--text)", fontWeight: 500 }}>{j.jobNumber}</span>
                  </td>
                  <td style={{ color: "var(--muted)" }}>{j.familyName}</td>
                  <td>{j.projectName ?? "—"}</td>
                  <td className="num mono">{j.unitCount}</td>
                  <td>
                    {j.unitRollup.length > 0 ? (
                      <StageSpine variant="mini" segments={j.unitRollup} />
                    ) : (
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>No schedule</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div className="pbar" style={{ flex: 1, marginTop: 0 }}>
                        <i style={{ width: `${j.percentComplete}%` }} />
                      </div>
                      <span className="mono" style={{ fontSize: 12 }}>{j.percentComplete}%</span>
                    </div>
                  </td>
                  <td>
                    {j.committedDeliveryDate == null ? (
                      <span style={{ color: "var(--muted)" }}>No date set</span>
                    ) : j.forecastVarianceDays == null ? (
                      <span style={{ color: "var(--muted)" }}>—</span>
                    ) : (
                      <span
                        className="mono"
                        style={{ color: j.forecastVarianceDays > 0 ? "var(--s-overdue)" : "var(--s-complete)", fontWeight: 600 }}
                      >
                        {j.forecastVarianceDays > 0 ? "+" : ""}
                        {j.forecastVarianceDays}d
                      </span>
                    )}
                  </td>
                  <td className="num mono" style={{ color: j.openHoldPoints > 0 ? "var(--s-hold)" : "var(--muted)" }}>
                    {j.openHoldPoints}
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: 12 }}>{fmtWhen(j.lastActivityAt)}</td>
                </JobRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
