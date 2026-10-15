// Floor screen skeleton: header, spine, and five rows, matching the final layout.
export default function FloorLoading() {
  return (
    <div className="fl-wrap">
      <span className="skel" style={{ width: 180, height: 28 }} />
      <span className="skel" style={{ width: "100%", height: 14, marginTop: 10 }} />
      <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <span key={i} className="skel" style={{ width: "100%", height: 64 }} />
        ))}
      </div>
    </div>
  );
}
