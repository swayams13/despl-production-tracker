// Matches the final layout: header, two cards, variant tabs, steps table.
export default function PartFamilyLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 280, height: 20 }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 14 }}>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card" style={{ padding: 16, display: "grid", gap: 8 }}>
            {Array.from({ length: 3 }).map((__, j) => (
              <span key={j} className="skel" style={{ width: j === 0 ? "40%" : "80%", height: 14 }} />
            ))}
          </div>
        ))}
      </div>
      <div className="card">
        <div style={{ padding: 16, display: "grid", gap: 8 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 28 }} />
          ))}
        </div>
      </div>
    </>
  );
}
