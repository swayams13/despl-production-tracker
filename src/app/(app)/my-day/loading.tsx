// Route-level Suspense fallback while the server component awaits getActor +
// loadMyDay + myDepartments. Mirrors the final header + KPI strip + tabs +
// card layout (UX_FINAL_REVIEW.md §9: "queue list skeleton shows 3
// placeholder rows; the page chrome (header, nav) never re-renders" — nav
// lives in layout.tsx, above this boundary, so it's untouched already).
// This page had no loading.tsx at all before Phase 4.
export default function MyDayLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 100, height: 20 }} />
        <span className="skel" style={{ width: 260, height: 12, marginLeft: 10 }} />
      </div>
      <div className="kpis" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="kpi" key={i}>
            <span className="skel" style={{ width: 90, height: 10.5 }} />
            <div style={{ marginTop: 8 }}>
              <span className="skel" style={{ width: 50, height: 24 }} />
            </div>
          </div>
        ))}
      </div>
      <div className="tabs">
        {["Needs attention", "Due today", "With QC", "Up next", "On hold", "Pool"].map((label) => (
          <span key={label} className="tab" style={{ opacity: 0.5 }}>
            {label}
          </span>
        ))}
      </div>
      <div className="card ws-card">
        <div className="hd">
          <span className="skel" style={{ width: 60, height: 12 }} />
        </div>
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 40 }} />
          ))}
        </div>
      </div>
    </>
  );
}
