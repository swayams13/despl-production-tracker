export default function MasterImportLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 200, height: 20 }} />
      </div>
      <div className="card" style={{ padding: 16, display: "grid", gap: 10 }}>
        <span className="skel" style={{ width: "50%", height: 16 }} />
        <span className="skel" style={{ width: "100%", height: 40 }} />
      </div>
    </>
  );
}
