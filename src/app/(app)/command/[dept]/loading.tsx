// Route-level Suspense fallback while the server component awaits
// loadCommandCenter. This route had no loading.tsx at all before Phase 4.
export default function CommandCenterLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 140, height: 20 }} />
        <span className="skel" style={{ width: 260, height: 12, marginLeft: 10 }} />
      </div>
      <div className="grid-h">
        <div className="card ws-card">
          <div className="hd"><span className="skel" style={{ width: 90, height: 12 }} /></div>
          <div style={{ padding: 16, display: "grid", gap: 12 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <span key={i} className="skel" style={{ width: "100%", height: 32 }} />
            ))}
          </div>
        </div>
        <div className="card ws-card">
          <div className="hd"><span className="skel" style={{ width: 70, height: 12 }} /></div>
          <div style={{ padding: 16 }}>
            <span className="skel" style={{ width: "100%", height: 80 }} />
          </div>
        </div>
      </div>
      <div className="card ws-card" style={{ marginTop: 14 }}>
        <div className="hd"><span className="skel" style={{ width: 50, height: 12 }} /></div>
        <div style={{ padding: 16, display: "grid", gap: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 24 }} />
          ))}
        </div>
      </div>
    </>
  );
}
