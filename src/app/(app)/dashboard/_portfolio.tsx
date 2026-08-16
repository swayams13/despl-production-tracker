import Link from "next/link";
import { CountUp } from "@/components/industrial/count-up";
import { HealthChip } from "@/components/industrial/health-chip";
import { StageSpine } from "@/components/industrial/stage-spine";
import { HEALTH_LABEL, HEALTH_ORDER, type JobHealth } from "@/lib/services/job-health";
import type { Portfolio, PortfolioRow } from "@/lib/services/portfolio.read";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/** URL slug per health, so a tile click survives refresh and the back button. */
export const SLUG: Record<JobHealth, string> = {
  ON_TRACK: "on-track",
  AT_RISK: "at-risk",
  DELAYED: "delayed",
  ON_HOLD: "on-hold",
  COMPLETED: "completed",
  NOT_PLANNED: "not-planned",
};

export function healthFromSlug(slug: string | undefined): JobHealth | null {
  if (!slug) return null;
  const hit = HEALTH_ORDER.find((h) => SLUG[h] === slug);
  return hit ?? null;
}

export function PortfolioBand({
  portfolio,
  activeFilter,
  jobParam,
}: {
  portfolio: Portfolio;
  activeFilter: JobHealth | null;
  /** Current `?job=`, carried through every filter link so filtering never resets the selection. */
  jobParam?: string;
}) {
  const { counts, rows, cancelledCount } = portfolio;
  const shown = activeFilter ? rows.filter((r) => r.health === activeFilter) : rows;

  /** `/dashboard` with the given health filter, keeping the selected job. */
  const href = (health: JobHealth | null) => {
    const q = [health ? `health=${SLUG[health]}` : "", jobParam ? `job=${jobParam}` : ""].filter(Boolean);
    return q.length ? `/dashboard?${q.join("&")}` : "/dashboard";
  };

  if (rows.length === 0) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="hd"><h3>Projects</h3></div>
        <p className="note" style={{ margin: "16px 0" }}>
          No projects yet. Create a job to start tracking it here.{" "}
          <Link href="/jobs" className="btn btn-ghost">Go to jobs</Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="kpis-portfolio" style={{ marginBottom: 12 }}>
        <div className="kpi">
          <h6>Active projects</h6>
          <div className="v mono"><CountUp value={counts.active} /></div>
          <div className="sub">in flight now</div>
        </div>
        {HEALTH_ORDER.map((h) => {
          const isActive = activeFilter === h;
          return (
            <Link
              key={h}
              href={href(isActive ? null : h)}
              className={`kpi clicky${isActive ? " selected" : ""}`}
              aria-current={isActive ? "true" : undefined}
            >
              <h6>{HEALTH_LABEL[h]}</h6>
              <div className="v mono"><CountUp value={counts[h]} /></div>
              <div className="sub">
                <HealthChip health={h} />
              </div>
            </Link>
          );
        })}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="hd">
          <h3>Projects — worst first</h3>
          {activeFilter && (
            <Link href={href(null)} className="chip" style={{ marginLeft: "auto", background: "rgba(255,122,26,.14)", color: "var(--accent)" }}>
              <i style={{ background: "var(--accent)" }} />
              {HEALTH_LABEL[activeFilter]} · clear
            </Link>
          )}
          {!activeFilter && (
            <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>
              click a card above to filter
            </span>
          )}
        </div>
        <div style={{ padding: "4px 8px 10px", overflowX: "auto" }}>
          <table className="matrix">
            <thead>
              <tr>
                <th style={{ minWidth: 110 }}>Job</th>
                <th style={{ minWidth: 140 }}>Client</th>
                <th style={{ minWidth: 100 }}>Health</th>
                <th style={{ minWidth: 130 }}>Complete</th>
                <th style={{ minWidth: 120 }}>Stages</th>
                <th>Promised</th>
                <th>Forecast</th>
                <th>Variance</th>
                <th>Overdue</th>
                <th>Holds</th>
                <th style={{ minWidth: 140 }}>Last 24h</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => <Row key={r.id} r={r} />)}
            </tbody>
          </table>
          {shown.length === 0 && (
            <p className="note" style={{ margin: "16px 0" }}>
              No projects are {HEALTH_LABEL[activeFilter!].toLowerCase()} right now.{" "}
              <Link href={href(null)} className="btn btn-ghost">Show all</Link>
            </p>
          )}
        </div>
        {cancelledCount > 0 && (
          <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", color: "var(--muted)", fontSize: 11 }}>
            {cancelledCount} cancelled — not shown
          </div>
        )}
      </div>
    </>
  );
}

function Row({ r }: { r: PortfolioRow }) {
  const v = r.forecastVarianceDays;
  const noUnits = r.unitRollup.length === 0;
  return (
    <tr>
      <td><Link href={`/jobs/${r.id}`} className="mono">{r.jobNumber}</Link></td>
      <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.clientName}</td>
      <td><HealthChip health={r.health} /></td>
      <td>
        <div className="otbar">
          <div className="bar"><i style={{ width: `${r.percentComplete}%`, background: "var(--s-complete)" }} /></div>
          <span className="mono" style={{ fontSize: 11 }}>{r.percentComplete}%</span>
        </div>
      </td>
      <td>
        {noUnits ? (
          <span style={{ color: "var(--muted)" }} title="No units defined yet">—</span>
        ) : (
          <StageSpine variant="mini" segments={r.unitRollup} />
        )}
      </td>
      <td className="mono">{fmtDate(r.deliveryDate)}</td>
      <td className="mono">{fmtDate(r.forecastDispatch)}</td>
      <td className="mono" style={{ color: v === null ? undefined : v > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
        {v === null ? "—" : `${v > 0 ? "+" : ""}${v}d`}
      </td>
      <td>
        {r.overduePlans > 0 ? (
          <Link href="/workspace?status=overdue" className="mono" style={{ color: "var(--s-overdue)" }}>
            {r.overduePlans}
          </Link>
        ) : (
          <span className="mono" style={{ color: "var(--muted)" }}>0</span>
        )}
      </td>
      <td className="mono" style={{ color: r.openHoldPoints > 0 ? "var(--s-hold)" : "var(--muted)" }}>{r.openHoldPoints}</td>
      <td className="mono" style={{ fontSize: 11 }}>
        <span style={{ color: "var(--s-complete)" }}>+{r.verifiedLast24h}</span>
        {" · "}
        <span style={{ color: r.newlyOverdueLast24h > 0 ? "var(--s-overdue)" : "var(--muted)" }}>{r.newlyOverdueLast24h} late</span>
        {" · "}
        <span style={{ color: r.holdsOpenedLast24h > 0 ? "var(--s-hold)" : "var(--muted)" }}>{r.holdsOpenedLast24h} hold</span>
      </td>
      <td style={{ color: "var(--muted)", fontSize: 11 }}>{fmtRelative(r.lastActivityAt)}</td>
    </tr>
  );
}
