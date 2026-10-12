// Matches the final layout: header, totals strip, filter row, table rows.
export default function MasterDataLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 160, height: 20 }} />
      </div>
      <div className="card" style={{ marginBottom: 14, padding: 16, display: "flex", gap: 16 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <span key={i} className="skel" style={{ width: 90, height: 14 }} />
        ))}
      </div>
      <div className="card">
        <div style={{ padding: 16, display: "grid", gap: 8 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 28 }} />
          ))}
        </div>
      </div>
    </>
  );
}
