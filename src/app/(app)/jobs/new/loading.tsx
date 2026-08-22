// Route-level Suspense fallback while the server component awaits
// loadIntakeOptions. Mirrors the wizard's final layout (header + step rail +
// one card) rather than a full-page spinner — DESIGN_SPEC's loading-state rule.
export default function NewJobLoading() {
  return (
    <>
      <div className="page-h">
        <h1>New job</h1>
      </div>
      <div className="wiz-steps">
        {["Order", "Type & route", "Equipment", "Configuration", "Review"].map((label) => (
          <div key={label} className="wiz-step">
            <span className="wiz-step-n skel" />
            <span className="skel" style={{ width: 60, height: 10 }} />
          </div>
        ))}
      </div>
      <div className="card">
        <div className="hd"><span className="skel" style={{ width: 140, height: 12 }} /></div>
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 32 }} />
          ))}
        </div>
      </div>
    </>
  );
}
