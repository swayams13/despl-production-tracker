import Link from "next/link";
import { redirect } from "next/navigation";
import { getActor, ROLES, hasRole } from "@/lib/authz";
import { loadJobKpis, type JobKpis } from "@/lib/services/workspace.read";
import { loadPortfolio, type PortfolioRow } from "@/lib/services/portfolio.read";
import { PortfolioBand, healthFromSlug } from "./_portfolio";
import { CountUp } from "@/components/industrial/count-up";
import { Sunburst, type SunburstNode } from "@/components/viz";
import { portfolioToSunburst } from "./_sunburst-data";

const STATUS_COLS = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "COMPLETE", "ON_HOLD"] as const;
const STATUS_LABELS: Record<(typeof STATUS_COLS)[number], string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  COMPLETE: "Complete",
  ON_HOLD: "On hold",
};
// §11.2's display vocabulary — the matrix's raw ProcessPlanStatus columns map
// 1:1 onto it (this table has no "overdue" column of its own; overdue plans
// still sit under NOT_STARTED/IN_PROGRESS here, same nuance noted in workspace.read.ts).
const STATUS_COLOR: Record<(typeof STATUS_COLS)[number], string> = {
  NOT_STARTED: "var(--s-idle)",
  IN_PROGRESS: "var(--s-progress)",
  SUBMITTED: "var(--s-submitted)",
  COMPLETE: "var(--s-complete)",
  ON_HOLD: "var(--s-hold)",
};
const STATUS_FILTER: Record<(typeof STATUS_COLS)[number], string> = {
  NOT_STARTED: "idle",
  IN_PROGRESS: "progress",
  SUBMITTED: "submitted",
  COMPLETE: "complete",
  ON_HOLD: "hold",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function onTimeColor(pct: number): string {
  if (pct >= 85) return "var(--s-complete)";
  if (pct >= 75) return "var(--s-hold)";
  return "var(--s-overdue)";
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Project switcher for the detail section. Rendered in BOTH page branches — a
 * NOT_PLANNED job is a supported selection, and without this the no-schedule
 * branch would leave the browser's back button as the only way out of it.
 */
function JobSelector({
  rows,
  jobId,
  healthSlug,
}: {
  rows: PortfolioRow[];
  jobId: number | null;
  healthSlug: string | undefined;
}) {
  return (
    <nav className="sub" style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Select project">
      {rows.map((r) => (
        <Link
          key={r.id}
          href={`/dashboard?job=${r.id}${healthSlug ? `&health=${healthSlug}` : ""}`}
          className={`chip ${r.id === jobId ? "c-progress" : "c-idle"}`}
          aria-current={r.id === jobId ? "true" : undefined}
        >
          <i />
          {r.jobNumber}
        </Link>
      ))}
    </nav>
  );
}

/**
 * S13b — sunburst over `loadPortfolio()`'s existing output (no new query):
 * health -> job -> stage status. A new card alongside "Projects — worst
 * first" (rendered inside PortfolioBand), not a replacement for it — both
 * stay so the numbers can be cross-checked. Renders in both page branches
 * (with and without a selected job's schedule) since this is portfolio-wide,
 * not scoped to `k`.
 */
function PortfolioHealthCard({ data }: { data: SunburstNode[] }) {
  return (
    <div className="card" style={{ marginTop: 8, marginBottom: 8 }}>
      <div className="hd">
        <h3>Portfolio health</h3>
        <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>
          health → job → stage status
        </span>
      </div>
      <div style={{ padding: "16px 12px" }}>
        <Sunburst data={data} />
      </div>
    </div>
  );
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.MANAGEMENT, ROLES.PRODUCTION_HEAD, ROLES.ADMIN)) redirect("/my-day");

  const sp = await searchParams;
  const portfolio = await loadPortfolio(actor);
  const sunburstData = portfolioToSunburst(portfolio);
  const healthSlug = first(sp.health);
  const activeFilter = healthFromSlug(healthSlug);

  // Default to the worst-off project, which is row 0 — that is the whole point
  // of the worst-first sort. An explicit ?job= wins so a link stays stable.
  const requested = Number(first(sp.job));
  const selected =
    portfolio.rows.find((r) => r.id === requested) ?? portfolio.rows[0] ?? null;
  const jobId = selected?.id ?? null;
  // Only an explicit, valid `?job=` is carried through the health-filter links —
  // filtering must not silently reset a chosen project, but it must also not pin
  // the worst-off default into the URL for someone who never picked one.
  const jobParam = selected && selected.id === requested ? String(selected.id) : undefined;

  const k: JobKpis | null = jobId ? await loadJobKpis(actor, jobId) : null;

  if (!k) {
    return (
      <>
        <div className="page-h"><h1>Dashboard</h1></div>
        <PortfolioBand portfolio={portfolio} activeFilter={activeFilter} jobParam={jobParam} />
        <PortfolioHealthCard data={sunburstData} />
        {portfolio.rows.length > 0 && (
          <div className="page-h" style={{ marginTop: 8 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>
              Project detail — <span className="mono">{selected?.jobNumber ?? "—"}</span>
            </h2>
            <JobSelector rows={portfolio.rows} jobId={jobId} healthSlug={healthSlug} />
          </div>
        )}
        <p className="note">
          {selected
            ? `No current schedule for ${selected.jobNumber}. Generate one to see its detail cards.`
            : "No projects yet."}
        </p>
      </>
    );
  }

  const completeCount = k.byState.DONE ?? 0;
  const onTrack = k.totalPlans - k.overdue;
  const maxThroughput = Math.max(1, ...k.throughputByWeek.map((w) => w.count), k.throughputTargetPerWeek ?? 0);
  const maxOffenderDays = Math.max(1, ...k.cycleTimeOffenders.map((o) => Math.max(o.standardDays, o.avgActualDays)));
  const now = new Date();

  return (
    <>
      <div className="page-h">
        <h1>Dashboard</h1>
        <span className="sub" style={{ marginLeft: "auto" }}>
          {now.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" })} · as of{" "}
          <span className="mono">{now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
        </span>
      </div>

      <PortfolioBand portfolio={portfolio} activeFilter={activeFilter} jobParam={jobParam} />
      <PortfolioHealthCard data={sunburstData} />

      <div className="page-h" style={{ marginTop: 8 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>
          Project detail — <span className="mono">{selected?.jobNumber}</span>
          {selected?.projectName ? <span style={{ color: "var(--muted)", fontWeight: 500 }}> · {selected.projectName}</span> : null}
        </h2>
        <JobSelector rows={portfolio.rows} jobId={jobId} healthSlug={healthSlug} />
        <span className="sub" style={{ marginLeft: "auto" }}>
          {k.equipmentName ? `${k.equipmentName} · ` : ""}
          {k.designCode ? `${k.designCode} · ` : ""}
          {k.unitCount} units
        </span>
      </div>

      <div className="kpis">
        <div className="kpi">
          <h6>Overall completion</h6>
          <div className="v mono"><CountUp value={k.percentComplete} /><small>%</small></div>
          <div className="sub"><span className="mono">{completeCount} of {k.totalPlans}</span> plans complete</div>
          <div className="pbar"><i style={{ width: `${k.percentComplete}%` }} /></div>
        </div>

        <Link href="/workspace" className="kpi clicky">
          <h6>On track</h6>
          <div className="v mono"><CountUp value={onTrack} /></div>
          <div className="sub">not currently overdue</div>
        </Link>

        <Link href="/workspace?status=overdue" className={`kpi clicky${k.overdue > 0 ? " alert" : ""}`}>
          <h6>At-risk / overdue</h6>
          <div className="v mono" style={{ color: k.overdue > 0 ? "var(--s-overdue)" : undefined }}><CountUp value={k.overdue} /></div>
          <div className="sub">click to review</div>
        </Link>

        <div className="kpi">
          <h6>Open hold points</h6>
          <div className="v mono"><CountUp value={k.openHoldPoints} /></div>
          <div className="sub">
            {k.oldestHoldAgeDays !== null
              ? <>oldest open <b className="mono" style={{ color: "var(--s-hold)" }}>{k.oldestHoldAgeDays}d</b> · {k.awaitingTpiCount} await TPI</>
              : "No open hold points"}
          </div>
        </div>

        <div className="kpi">
          <h6>Forecast dispatch</h6>
          <div className="v mono" style={{ fontSize: 22, paddingTop: 4 }}>{fmtDate(k.forecastDispatch)}</div>
          <div className="sub">
            {k.committedDeliveryDate ? (
              <>
                <span className="delta" style={{ color: (k.forecastVarianceDays ?? 0) > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
                  {(k.forecastVarianceDays ?? 0) > 0 ? "+" : ""}{k.forecastVarianceDays}d
                </span>
                {" "}vs contractual <span className="mono">{fmtDate(k.committedDeliveryDate)}</span>
              </>
            ) : (
              "No contractual date set yet"
            )}
          </div>
        </div>
      </div>

      <div className="statstrip">
        <div className="stat"><h6>First-pass yield (QC)</h6><div className="v mono">{k.stats.firstPassYieldPct ?? "—"}{k.stats.firstPassYieldPct !== null && <small>%</small>}</div></div>
        <div className="stat">
          <h6>Avg cycle vs standard</h6>
          <div className="v mono" style={{ color: k.stats.avgCycleVsStandardDays === null ? undefined : k.stats.avgCycleVsStandardDays > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
            {k.stats.avgCycleVsStandardDays !== null ? (k.stats.avgCycleVsStandardDays > 0 ? "+" : "") + k.stats.avgCycleVsStandardDays : "—"}
            {k.stats.avgCycleVsStandardDays !== null && <small>d / stage</small>}
          </div>
        </div>
        <div className="stat">
          <h6>Plans verified · 7d</h6>
          <div className="v mono">{k.stats.stagesVerified7d}<small>{k.stats.stagesVerified7dDelta >= 0 ? "▲" : "▼"} {Math.abs(k.stats.stagesVerified7dDelta)}</small></div>
        </div>
        <div className="stat"><h6>Reasons pending</h6><div className="v mono" style={{ color: k.stats.reasonsPending > 0 ? "var(--s-hold)" : undefined }}>{k.stats.reasonsPending}</div></div>
        <div className="stat"><h6>Active users today</h6><div className="v mono">{k.stats.activeUsersToday}<small>of {k.stats.activeUsersTotal}</small></div></div>
      </div>

      <div className="grid-2">
        <SCurveCard sCurve={k.sCurve} />

        <div className="card">
          <div className="hd">
            <h3>Critical path — blocking dispatch</h3>
            <span className="chip c-overdue" style={{ marginLeft: "auto" }}><i />{k.criticalPathBlocking.length} item{k.criticalPathBlocking.length === 1 ? "" : "s"}</span>
          </div>
          {k.criticalPathBlocking.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No items on the critical path are currently overdue.</p>
          ) : (
            k.criticalPathBlocking.map((r) => (
              <Link key={r.planId} href={`/workspace?dept=${r.departmentId}`} className="cp-row">
                <div className="t">
                  <b>{r.processName}</b>
                  <span>Unit {r.serialNo} · <span className="dept-tag">{r.deptName}</span></span>
                </div>
                <span className="cp-days">{r.daysOverdue}d</span>
              </Link>
            ))
          )}
          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)" }}>
            <Link href="/workspace" className="btn btn-ghost">Open in workspace →</Link>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="hd">
          <h3>Department × status</h3>
          <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>click a cell to filter workspace</span>
        </div>
        <div style={{ padding: "4px 8px 10px", overflowX: "auto" }}>
          <table className="matrix">
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Department</th>
                {STATUS_COLS.map((s) => <th key={s}>{STATUS_LABELS[s]}</th>)}
                <th style={{ minWidth: 150 }}>On-time %</th>
              </tr>
            </thead>
            <tbody>
              {k.deptMatrix.map((row) => (
                <tr key={row.departmentId}>
                  <td>{row.department}</td>
                  {STATUS_COLS.map((s) => {
                    const count = row.counts[s] ?? 0;
                    return (
                      <td key={s}>
                        <Link
                          href={`/workspace?dept=${row.departmentId}&status=${STATUS_FILTER[s]}`}
                          className={`mx-cell${count === 0 ? " mx-zero" : ""}`}
                          style={count > 0 ? { background: STATUS_COLOR[s], opacity: 0.16 + Math.min(count, 20) * 0.03, color: "var(--text)" } : undefined}
                        >
                          {count > 0 ? count : "0"}
                        </Link>
                      </td>
                    );
                  })}
                  <td>
                    {row.onTimePct === null ? (
                      <span style={{ color: "var(--muted)" }}>—</span>
                    ) : (
                      <div className="otbar">
                        <div className="bar"><i style={{ width: `${row.onTimePct}%`, background: onTimeColor(row.onTimePct) }} /></div>
                        <span className="mono" style={{ fontSize: 11 }}>{row.onTimePct}%</span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid-h">
        <div className="card">
          <div className="hd">
            <h3>Plans verified — per week</h3>
            {k.throughputTargetPerWeek !== null && (
              <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>target {k.throughputTargetPerWeek} / wk to hit contractual date</span>
            )}
          </div>
          <div style={{ padding: "16px 12px 10px" }}>
            <div className="bars">
              {k.throughputByWeek.map((w, i) => (
                <div className="b" key={i}>
                  <i style={{ height: `${(w.count / maxThroughput) * 100}%` }} title={`${w.count} verified`} />
                  <span>{w.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="hd">
            <h3>Cycle time vs standard — worst offenders</h3>
            <div className="legend">
              <span><i style={{ background: "var(--track)", height: 4 }} />Standard</span>
              <span><i style={{ background: "var(--s-overdue)" }} />Actual over</span>
            </div>
          </div>
          {k.cycleTimeOffenders.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No completed process is running long against its standard duration.</p>
          ) : (
            <div style={{ padding: "8px 0" }}>
              {k.cycleTimeOffenders.map((o) => (
                <div className="gbar-row" key={o.processName}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.processName}</span>
                  <div className="gbar">
                    <i className="std" style={{ width: `${(o.standardDays / maxOffenderDays) * 100}%` }} />
                    <i style={{ width: `${(o.avgActualDays / maxOffenderDays) * 100}%`, background: "var(--s-overdue)", opacity: 0.55 }} />
                  </div>
                  <span className="mono num" style={{ color: "var(--s-overdue)" }}>+{o.deltaDays}d</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid-h">
        <div className="card">
          <div className="hd">
            <h3>Overdue aging by department</h3>
            <div className="legend">
              <span><i style={{ background: "var(--s-hold)" }} />1–3d</span>
              <span><i style={{ background: "#E07B2E" }} />3–7d</span>
              <span><i style={{ background: "var(--s-overdue)" }} />7d+</span>
            </div>
          </div>
          {k.overdueAgingByDept.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No overdue plans right now.</p>
          ) : (
            <div style={{ padding: "8px 0" }}>
              {k.overdueAgingByDept.map((d) => {
                const total = d.d1to3 + d.d3to7 + d.d7plus;
                return (
                  <Link href={`/workspace?dept=${d.departmentId}&status=overdue`} className="age-row" key={d.departmentId}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.department}</span>
                    <div className="agebar">
                      {d.d1to3 > 0 && <i style={{ width: `${(d.d1to3 / total) * 100}%`, background: "var(--s-hold)" }} />}
                      {d.d3to7 > 0 && <i style={{ width: `${(d.d3to7 / total) * 100}%`, background: "#E07B2E" }} />}
                      {d.d7plus > 0 && <i style={{ width: `${(d.d7plus / total) * 100}%`, background: "var(--s-overdue)" }} />}
                    </div>
                    <span className="mono num">{total}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="hd">
            <h3>Open hold points — QCP / ITP</h3>
            <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>top {k.holdPointsTop.length} of {k.openHoldPoints} by age</span>
          </div>
          {k.holdPointsTop.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No open hold points.</p>
          ) : (
            <div>
              {k.holdPointsTop.map((h) => (
                <div className="hp-row" key={`${h.qcpItemId}-${h.unitId}`}>
                  <span className="mono" style={{ color: "var(--muted)" }}>{h.srNo}</span>
                  <span className="hclass">{h.classCode}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.activity} · Unit {h.serialNo}</span>
                  <span className={`chip ${h.status === "Reinspect" ? "c-overdue" : h.status === "QC review" ? "c-submitted" : "c-hold"}`}><i />{h.status}</span>
                  <span className="mono" style={{ color: "var(--s-overdue)" }}>{h.ageDays}d</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Planned-vs-actual line chart from the run's own weekly cumulative counts
 * (§4.2's S-curve). Deliberately a plain scaled polyline, not the mockup's
 * hand-drawn bezier — the mockup's curve was illustrative; this one is real
 * per-week data, so its shape is whatever the schedule actually says. Full
 * motion/tooltip polish is §9's dedicated polish pass (§7), not this session.
 */
function SCurveCard({ sCurve }: { sCurve: JobKpis["sCurve"] }) {
  const W = 640;
  const H = 230;
  const padL = 50;
  const padR = 20;
  const padT = 20;
  const padB = 30;

  if (sCurve.length < 2) {
    return (
      <div className="card">
        <div className="hd"><h3>Schedule S-curve — planned vs actual</h3></div>
        <p className="note" style={{ margin: "16px 0" }}>Not enough schedule data yet to plot a curve.</p>
      </div>
    );
  }

  const maxVal = Math.max(...sCurve.map((p) => p.planned), ...sCurve.map((p) => p.actual ?? 0), 1);
  const stepX = (W - padL - padR) / (sCurve.length - 1);
  const yFor = (v: number) => padT + (1 - v / maxVal) * (H - padT - padB);
  const xFor = (i: number) => padL + i * stepX;

  const plannedPts = sCurve.map((p, i) => `${xFor(i)},${yFor(p.planned)}`).join(" ");
  const actualPts = sCurve.filter((p) => p.actual !== null).map((p, i) => `${xFor(i)},${yFor(p.actual!)}`).join(" ");
  const lastActualIdx = sCurve.map((p) => p.actual).lastIndexOf(sCurve.map((p) => p.actual).filter((a) => a !== null).at(-1) ?? null);
  const lastActual = sCurve[lastActualIdx];
  const variancePct =
    lastActual?.actual !== null && lastActual?.actual !== undefined && lastActual.planned > 0
      ? Math.round(((lastActual.actual - lastActual.planned) / lastActual.planned) * 1000) / 10
      : null;

  return (
    <div className="card">
      <div className="hd">
        <h3>Schedule S-curve — planned vs actual</h3>
        <div className="legend">
          <span><i style={{ background: "var(--muted)" }} />Planned</span>
          <span><i style={{ background: "var(--accent)" }} />Actual{variancePct !== null && ` · ${variancePct > 0 ? "+" : ""}${variancePct}%`}</span>
        </div>
      </div>
      <div style={{ padding: 16 }}>
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Planned versus actual plans complete over time">
          <g stroke="var(--border)" strokeDasharray="3 4">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <line key={f} x1={padL} y1={padT + f * (H - padT - padB)} x2={W - padR} y2={padT + f * (H - padT - padB)} />
            ))}
          </g>
          <g fill="var(--muted)" fontSize="10" fontFamily="'JetBrains Mono',monospace">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <text key={f} x={4} y={padT + (1 - f) * (H - padT - padB) + 3}>{Math.round(f * maxVal)}</text>
            ))}
            {sCurve.map((p, i) => (i % Math.ceil(sCurve.length / 6) === 0 ? <text key={i} x={xFor(i) - 6} y={H - 8}>{p.label}</text> : null))}
          </g>
          <polyline points={plannedPts} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="5 4" />
          {actualPts && <polyline points={actualPts} fill="none" stroke="var(--accent)" strokeWidth="2" />}
          {lastActual?.actual !== null && lastActual?.actual !== undefined && (
            <circle cx={xFor(lastActualIdx)} cy={yFor(lastActual.actual)} r="3.5" fill="var(--accent)" />
          )}
        </svg>
        <table className="sr-only">
          <caption>Planned vs actual plans complete, by week</caption>
          <thead><tr><th>Week</th><th>Planned</th><th>Actual</th></tr></thead>
          <tbody>{sCurve.map((p) => <tr key={p.label}><td>{p.label}</td><td>{p.planned}</td><td>{p.actual ?? "—"}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
