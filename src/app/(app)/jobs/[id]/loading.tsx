// Route-level Suspense fallback while the server component awaits its
// Promise.all of tab data. Mirrors the final header + tabs + card layout
// rather than a full-page spinner — DESIGN_SPEC's loading-state rule.
// Applies to every tab (overview/gantt/bom/assembly/qcp/packing/activity/
// client), not just packing — this page had no loading.tsx at all before.
export default function JobDetailLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 140, height: 20 }} />
        <span className="skel" style={{ width: 220, height: 12, marginLeft: 10 }} />
      </div>
      <div className="tabs">
        {["Overview", "Timeline", "BOM & Components", "Assembly", "QCP", "Packing", "Activity"].map((label) => (
          <span key={label} className="tab" style={{ opacity: 0.5 }}>
            {label}
          </span>
        ))}
      </div>
      <div className="card">
        <div className="hd">
          <span className="skel" style={{ width: 160, height: 12 }} />
        </div>
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 32 }} />
          ))}
        </div>
      </div>
    </>
  );
}
