// Route-level Suspense fallback while the server component awaits
// loadDepartmentCards. This route had no loading.tsx at all before Phase 4.
export default function DepartmentsLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 120, height: 20 }} />
      </div>
      <div className="dept-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="dept-card" key={i} style={{ pointerEvents: "none" }}>
            <span className="skel" style={{ width: "60%", height: 14 }} />
            <div style={{ marginTop: 8 }}><span className="skel" style={{ width: "80%", height: 11 }} /></div>
            <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
              <span className="skel" style={{ width: 40, height: 20 }} />
              <span className="skel" style={{ width: 40, height: 20 }} />
              <span className="skel" style={{ width: 40, height: 20 }} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
