// Route-level Suspense fallback while the server component awaits
// loadDailyDigest + history. This route had no loading.tsx at all before
// Phase 4. UX_FINAL_REVIEW.md §9: "the report list appears immediately (it's
// static config); only the row counts/last-run timestamps skeleton" — this
// route's own equivalent (the digest itself) is what's actually async here.
export default function ReportsLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 90, height: 20 }} />
        <span className="skel" style={{ width: 220, height: 12, marginLeft: 10 }} />
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><span className="skel" style={{ width: 160, height: 12 }} /></div>
        <div style={{ padding: 16, display: "grid", gap: 10 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 20 }} />
          ))}
        </div>
      </div>
    </>
  );
}
