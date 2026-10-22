// Route-level fallback: mirrors the final layout (header, pickers, table, side panel), no full-page spinner.
export default function BomReleaseLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 160, height: 20 }} />
        <span className="skel" style={{ width: 200, height: 12, marginLeft: 10 }} />
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="hd"><span className="skel" style={{ width: 140, height: 12 }} /></div>
          <div style={{ padding: 16, display: "grid", gap: 10 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i} className="skel" style={{ width: "100%", height: 28 }} />
            ))}
          </div>
        </div>
        <div className="card">
          <div className="hd"><span className="skel" style={{ width: 160, height: 12 }} /></div>
          <div style={{ padding: 16, display: "grid", gap: 10 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <span key={i} className="skel" style={{ width: "100%", height: 20 }} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
