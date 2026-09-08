// Route-level Suspense fallback while the server component awaits
// loadPortfolio + loadJobKpis. This route had no loading.tsx at all before
// Phase 4 — per-panel skeletons matching UX_FINAL_REVIEW.md §9's
// "MetricCard and table skeletons render immediately, each panel resolves
// independently" rule (the panels themselves still load together server-side
// here — no streaming/Suspense boundaries per-panel exist yet — but the
// shell shows the right shape instead of a blank page either way).
export default function DashboardLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 100, height: 20 }} />
      </div>
      <div className="kpis-portfolio" style={{ marginBottom: 12 }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <div className="kpi" key={i}>
            <span className="skel" style={{ width: 70, height: 10.5 }} />
            <div style={{ marginTop: 8 }}><span className="skel" style={{ width: 40, height: 24 }} /></div>
          </div>
        ))}
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="hd"><span className="skel" style={{ width: 140, height: 12 }} /></div>
        <div style={{ padding: 16, display: "grid", gap: 10 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 24 }} />
          ))}
        </div>
      </div>
      <div className="kpis">
        {Array.from({ length: 5 }).map((_, i) => (
          <div className="kpi" key={i}>
            <span className="skel" style={{ width: 80, height: 10.5 }} />
            <div style={{ marginTop: 8 }}><span className="skel" style={{ width: 50, height: 24 }} /></div>
          </div>
        ))}
      </div>
    </>
  );
}
