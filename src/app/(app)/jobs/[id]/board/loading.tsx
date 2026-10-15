// Board skeleton: header, filter row, and a grid the shape of the matrix.
export default function BoardLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 220, height: 20 }} />
      </div>
      <span className="skel" style={{ width: "100%", height: 40, marginBottom: 12 }} />
      <div style={{ display: "grid", gap: 6 }}>
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} className="skel" style={{ width: "100%", height: 44 }} />
        ))}
      </div>
    </>
  );
}
