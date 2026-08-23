// Route-level Suspense fallback while the server component awaits
// loadVersionEditor. Mirrors the final header-card + two-table layout rather
// than a full-page spinner — DESIGN_SPEC's loading-state rule.
export default function VersionEditorLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 220, height: 20 }} />
      </div>
      {Array.from({ length: 2 }).map((_, i) => (
        <div className="card" key={i} style={{ marginBottom: 14 }}>
          <div className="hd"><span className="skel" style={{ width: 100, height: 12 }} /></div>
          <div style={{ padding: 16, display: "grid", gap: 10 }}>
            {Array.from({ length: 5 }).map((_, j) => (
              <span key={j} className="skel" style={{ width: "100%", height: 28 }} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
