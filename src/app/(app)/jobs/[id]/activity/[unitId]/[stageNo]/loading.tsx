// Route-level Suspense fallback while the server component awaits
// loadStageDetail + the department-members lookup. Mirrors the final
// header + primary-action bar + grid-2 (content/rail) layout.
export default function ActivityDetailLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 160, height: 20 }} />
        <span className="skel" style={{ width: 220, height: 12, marginLeft: 10 }} />
      </div>
      <div className="actd-primary-bar">
        <span className="skel" style={{ width: 120, height: 32 }} />
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="hd"><span className="skel" style={{ width: 140, height: 12 }} /></div>
          <div style={{ padding: 16, display: "grid", gap: 12 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <span key={i} className="skel" style={{ width: "100%", height: 24 }} />
            ))}
          </div>
        </div>
        <div className="card">
          <div className="hd"><span className="skel" style={{ width: 90, height: 12 }} /></div>
          <div style={{ padding: 16, display: "grid", gap: 8 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <span key={i} className="skel" style={{ width: "100%", height: 18 }} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
