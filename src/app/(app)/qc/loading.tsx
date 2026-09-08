// Route-level Suspense fallback while the server component awaits
// loadQcCockpit. This route had no loading.tsx at all before Phase 4.
// UX_FINAL_REVIEW.md §9: "each queue card skeletons independently - one slow
// queue (e.g. Overdue) shouldn't delay Awaiting Verification from appearing"
// - this is a single server fetch today (no per-panel streaming), so both
// panels skeleton together; still the right shape, not a blank page.
export default function QcCockpitLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 160, height: 20 }} />
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><span className="skel" style={{ width: 180, height: 12 }} /></div>
        <div style={{ padding: 16, display: "grid", gap: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 24 }} />
          ))}
        </div>
      </div>
      <div className="card">
        <div className="hd"><span className="skel" style={{ width: 200, height: 12 }} /></div>
        <div style={{ padding: 16, display: "grid", gap: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 24 }} />
          ))}
        </div>
      </div>
    </>
  );
}
