import Link from "next/link";
import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadJobs } from "@/lib/services/jobs.read";
import { StageSpine } from "@/components/industrial/stage-spine";
import { ResponsiveTable } from "@/components/industrial/responsive-table";
import { JobRow, JobCardView } from "./_row";

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

const PAGE_SIZE = 50;

/**
 * A requested page beyond the last real page (bookmarked URL, stale link,
 * hand-typed) must not render the empty state while jobs actually exist —
 * `loadJobs` still reports the true `total` regardless of `skip`/`take`, so
 * `totalPages` here is always accurate even when `page` itself overshot it.
 * Returns the page to redirect to, or `null` if `page` is already in range.
 */
export function outOfRangePage(page: number, totalPages: number): number | null {
  return totalPages > 0 && page > totalPages ? totalPages : null;
}

export default async function JobsList({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const { items: jobs, total } = await loadJobs(actor, { page, pageSize: PAGE_SIZE });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const redirectTo = outOfRangePage(page, totalPages);
  if (redirectTo !== null) redirect(`/jobs?page=${redirectTo}`);
  const canCreate = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return (
    <>
      <div className="page-h">
        <h1>Jobs</h1>
        <span className="sub">{total} job{total === 1 ? "" : "s"}</span>
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
          <ResponsiveTable
            table={
              // table-layout: fixed — 9 columns of free-text + a fixed-width
              // (25-stage) StageSpine overflow their container's natural
              // content width at 1024px (found overflowing 28-144px in
              // e2e's tablet project); fixed layout caps every column to its
              // % share instead of expanding past 100%, wrapping long text
              // rather than pushing the table wider than the viewport.
              <table style={{ tableLayout: "fixed" }}>
                <thead>
                  <tr>
                    <th style={{ width: "9%" }}>Job</th>
                    <th style={{ width: "10%" }}>Family</th>
                    <th style={{ width: "15%" }}>Description</th>
                    <th className="num" style={{ width: "6%" }}>Units</th>
                    <th style={{ width: "18%" }}>Stages</th>
                    <th style={{ width: "12%" }}>% complete</th>
                    <th style={{ width: "12%" }}>Forecast vs due</th>
                    <th className="num" style={{ width: "8%" }}>Open holds</th>
                    <th style={{ width: "10%" }}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <JobRow key={j.id} jobId={j.id}>
                      <td>
                        <span className="mono" style={{ color: "var(--text)", fontWeight: 500 }}>{j.jobNumber}</span>
                      </td>
                      <td style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.familyName}</td>
                      <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.projectName ?? "—"}</td>
                      <td className="num mono">{j.unitCount}</td>
                      <td style={{ overflow: "hidden" }}>
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
            }
            cards={jobs.map((j) => <JobCardView key={j.id} job={j} />)}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
            {page > 1 ? (
              <Link href={`?page=${page - 1}`} className="btn">Previous</Link>
            ) : (
              <span />
            )}
            <span className="sub">Page {page} of {totalPages}</span>
            {page < totalPages ? (
              <Link href={`?page=${page + 1}`} className="btn">Next</Link>
            ) : (
              <span />
            )}
          </div>
        </div>
      )}
    </>
  );
}
