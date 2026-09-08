// Route-level Suspense fallback while the server component awaits
// loadWeldingView. This route had no loading.tsx at all before Phase 4.
export default function WeldingLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 90, height: 20 }} />
        <span className="skel" style={{ width: 260, height: 12, marginLeft: 10 }} />
      </div>
      <div className="card">
        <div className="hd"><span className="skel" style={{ width: 140, height: 12 }} /></div>
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 40 }} />
          ))}
        </div>
      </div>
    </>
  );
}
