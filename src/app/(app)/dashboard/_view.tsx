"use client";

// Client components on purpose: server-rendered, keyed list rows are streamed as many separate outlined Flight
// rows, and a client-side navigation to a page with dozens of them never commits in the browser (found in the
// L2.7-L2.9 integration run, 16 Oct 2026). As props they travel in one row. Links that stay on /dashboard are plain
// anchors (a full load): a second same-route client navigation still stalled intermittently on a slow runner.
import Link from "next/link";
import { HealthChip } from "@/components/industrial/health-chip";
import { StageSpine } from "@/components/industrial/stage-spine";
import { ResponsiveTable } from "@/components/industrial/responsive-table";
import type { PortfolioRow } from "@/lib/services/portfolio.read";
import {
  ATTENTION_LIMIT,
  portfolioHref,
  type DeptBottleneck,
  type PortfolioException,
  type PortfolioTile,
} from "@/lib/shared/portfolio";
import { portfolioMilestoneText } from "@/lib/shared/milestones";
import type { JobHealth } from "@/lib/services/job-health";

/** Lean Core L2.7: the Portfolio's four blocks. Links only: every control is a real destination. */

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
}

function fmtAge(days: number): string {
  return days <= 0 ? "today" : `${days} d`;
}

export function Tiles({ tiles }: { tiles: PortfolioTile[] }) {
  return (
    <nav className="pf-tiles" aria-label="Portfolio numbers">
      {tiles.map((t) => (
        <a
          key={t.id}
          href={t.href}
          className={`kpi clicky${t.selected ? " selected" : ""}${t.alert ? " alert" : ""}`}
          aria-current={t.selected ? "true" : undefined}
        >
          <h6>{t.label}</h6>
          <div className="v mono">{t.value}</div>
        </a>
      ))}
    </nav>
  );
}

function Blocker({ e }: { e: PortfolioException | undefined }) {
  if (!e) return <span className="pf-muted">None</span>;
  return (
    <Link prefetch={false} href={e.href} className="pf-blocker">
      {e.what}
    </Link>
  );
}

function Dates({ r }: { r: PortfolioRow }) {
  const v = r.forecastVarianceDays;
  return (
    <span className="mono">
      {fmtDate(r.committedDeliveryDate)} → {r.forecastDispatch ? fmtDate(r.forecastDispatch) : <span className="pf-muted">not scheduled</span>}
      {v !== null && (
        <b className="pf-var" style={{ color: v > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
          {v === 0 ? "on date" : `${v > 0 ? "+" : "−"}${Math.abs(v)} d`}
        </b>
      )}
    </span>
  );
}

function Focus({ r, health, focused }: { r: PortfolioRow; health: JobHealth | null; focused: boolean }) {
  if (focused) return null;
  return (
    <a href={portfolioHref({ health, jobId: r.id })} className="pf-focus" aria-label={`Show only ${r.jobNumber}`}>
      Focus
    </a>
  );
}

/** Project health: six columns, worst first (the rows arrive worst-first); cards below 1024px. */
export function HealthTable({
  rows,
  topBlocker,
  health,
  jobId,
}: {
  rows: PortfolioRow[];
  topBlocker: Map<number, PortfolioException>;
  health: JobHealth | null;
  jobId: number | null;
}) {
  return (
    <ResponsiveTable
      table={
        <table className="pf-table">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Client</th>
              <th scope="col">Progress</th>
              <th scope="col">Milestone</th>
              <th scope="col">Committed → forecast</th>
              <th scope="col">Health</th>
              <th scope="col">Top blocker</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <th scope="row" className="pf-job">
                  <Link prefetch={false} href={`/jobs/${r.id}`} className="mono">{r.jobNumber}</Link>
                  <Focus r={r} health={health} focused={jobId === r.id} />
                  {r.projectName && <small>{r.projectName}</small>}
                  {r.unitRollup.length > 0 && <StageSpine variant="mini" segments={r.unitRollup} />}
                </th>
                <td>{r.clientName}</td>
                <td>
                  <div className="otbar">
                    <div className="bar"><i style={{ width: `${r.percentComplete}%`, background: "var(--s-complete)" }} /></div>
                    <span className="mono">{r.percentComplete}%</span>
                  </div>
                </td>
                <td style={{ color: r.currentMilestone?.late ? "var(--s-overdue)" : undefined }}>
                  {portfolioMilestoneText(r) ?? <span title="No milestone list for this type of equipment yet">—</span>}
                </td>
                <td><Dates r={r} /></td>
                <td><HealthChip health={r.health} /></td>
                <td><Blocker e={topBlocker.get(r.id)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      cards={rows.map((r) => (
        <div className="rt-card" key={r.id}>
          <div className="rt-card-top">
            <Link prefetch={false} href={`/jobs/${r.id}`} className="mono pf-cardjob">{r.jobNumber}</Link>
            <HealthChip health={r.health} />
          </div>
          <div className="rt-card-meta">{r.clientName}{r.projectName ? ` · ${r.projectName}` : ""}</div>
          {r.unitRollup.length > 0 && <StageSpine variant="mini" segments={r.unitRollup} />}
          <div className="rt-card-row">
            <span>Progress <b className="mono">{r.percentComplete}%</b></span>
            {portfolioMilestoneText(r) && <span style={{ color: r.currentMilestone?.late ? "var(--s-overdue)" : undefined }}>{portfolioMilestoneText(r)}</span>}
            <Dates r={r} />
          </div>
          <div className="rt-card-row">
            <span>Top blocker</span>
            <Blocker e={topBlocker.get(r.id)} />
          </div>
          <Focus r={r} health={health} focused={jobId === r.id} />
        </div>
      ))}
    />
  );
}

const SEGMENTS = [
  { key: "blocked", label: "Blocked", href: "blockedHref" },
  { key: "overdue", label: "Overdue", href: "overdueHref" },
  { key: "rejected", label: "Rejected", href: "rejectedHref" },
] as const;

/** One row per department: three linked segments, each printing its number. */
export function Bottlenecks({ bars }: { bars: DeptBottleneck[] }) {
  if (bars.length === 0) return <p className="note">Nothing is blocked, overdue or rejected.</p>;
  const max = Math.max(...bars.map((b) => b.total));
  return (
    <>
      <ul className="pf-bn">
        {bars.map((b) => (
          <li key={b.deptId} className="pf-bn-row">
            <span className="pf-bn-name">{b.name}</span>
            <span className="pf-bn-bar" style={{ width: `${Math.max(12, (b.total / max) * 100)}%` }}>
              {SEGMENTS.map((s) =>
                b[s.key] > 0 ? (
                  <Link prefetch={false}
                    key={s.key}
                    href={b[s.href]}
                    className={`pf-seg pf-seg-${s.key}`}
                    style={{ flexGrow: b[s.key] }}
                    aria-label={`${b.name}: ${b[s.key]} ${s.label.toLowerCase()}`}
                  >
                    {b[s.key]}
                  </Link>
                ) : null,
              )}
            </span>
            <span className="mono pf-bn-total">{b.total}</span>
          </li>
        ))}
      </ul>
      <p className="pf-legend">
        <span><i className="pf-key pf-seg-blocked" />Blocked</span>
        <span><i className="pf-key pf-seg-overdue" />Overdue</span>
        <span><i className="pf-key pf-seg-rejected" />Rejected (NCR)</span>
      </p>
    </>
  );
}

/** The queue: worst job first, top 15. Each row ends in a link to where the work is done. */
export function Attention({ items, total }: { items: PortfolioException[]; total: number }) {
  if (items.length === 0) return <p className="note">Nothing needs attention right now.</p>;
  return (
    <>
      <ul className="pf-queue">
        {items.map((e) => (
          <li key={e.key} className="pf-q">
            <span className="mono pf-q-job">{e.jobNumber}</span>
            <span className="pf-q-what">{e.what}</span>
            <span className="pf-q-dept">{e.deptName}</span>
            <span className="pf-q-owner">{e.owner ?? <span className="pf-muted">—</span>}</span>
            <span className="mono pf-q-age">{fmtAge(e.ageDays)}</span>
            <Link prefetch={false} href={e.href} className="btn btn-ghost pf-q-act">{e.action}</Link>
          </li>
        ))}
      </ul>
      {total > items.length && <p className="pf-more">Showing the {ATTENTION_LIMIT} most urgent of {total}.</p>}
    </>
  );
}
