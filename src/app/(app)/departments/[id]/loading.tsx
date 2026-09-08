// Route-level Suspense fallback while the server component awaits
// loadDeptDetail. This route had no loading.tsx at all before Phase 4.
export default function DepartmentDetailLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 140, height: 20 }} />
        <span className="skel" style={{ width: 180, height: 12, marginLeft: 10 }} />
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><span className="skel" style={{ width: 90, height: 12 }} /></div>
        <div style={{ padding: 16, display: "grid", gap: 10 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 24 }} />
          ))}
        </div>
      </div>
      <div className="grid-h">
        <div className="card">
          <div className="hd"><span className="skel" style={{ width: 140, height: 12 }} /></div>
          <div style={{ padding: 16 }}><span className="skel" style={{ width: "100%", height: 100 }} /></div>
        </div>
        <div className="card">
          <div className="hd"><span className="skel" style={{ width: 120, height: 12 }} /></div>
          <div style={{ padding: 16 }}><span className="skel" style={{ width: "100%", height: 100 }} /></div>
        </div>
      </div>
    </>
  );
}
