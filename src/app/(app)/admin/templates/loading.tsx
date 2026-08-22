// Route-level Suspense fallback while the server component awaits
// loadTemplateIndex. Mirrors the final family-card/table layout rather than
// a full-page spinner — DESIGN_SPEC's loading-state rule.
export default function TemplatesLoading() {
  return (
    <>
      <div className="page-h">
        <h1>Process routes</h1>
      </div>
      {Array.from({ length: 2 }).map((_, i) => (
        <div className="card" key={i} style={{ marginBottom: 14 }}>
          <div className="hd"><span className="skel" style={{ width: 140, height: 12 }} /></div>
          <div style={{ padding: 16, display: "grid", gap: 10 }}>
            {Array.from({ length: 3 }).map((_, j) => (
              <span key={j} className="skel" style={{ width: "100%", height: 28 }} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
