// Team skeleton: the five numbers, the workload table and the pool.
export default function TeamLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 240, height: 20 }} />
      </div>
      <span className="skel" style={{ width: "100%", height: 56, marginBottom: 14 }} />
      <div style={{ display: "grid", gap: 6 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="skel" style={{ width: "100%", height: 44 }} />
        ))}
      </div>
    </>
  );
}
