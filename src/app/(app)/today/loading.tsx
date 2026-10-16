// Today skeleton: summary line, the Do-this-first card and a few rows.
export default function TodayLoading() {
  return (
    <div className="fl-wrap">
      <span className="skel" style={{ width: 120, height: 28 }} />
      <span className="skel" style={{ width: "70%", height: 14, marginTop: 10 }} />
      <span className="skel" style={{ width: "100%", height: 88, marginTop: 18 }} />
      <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={i} className="skel" style={{ width: "100%", height: 56 }} />
        ))}
      </div>
    </div>
  );
}
