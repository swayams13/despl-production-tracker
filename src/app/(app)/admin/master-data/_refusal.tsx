/** A refusal that names what is missing and who can clear it (build prompt §Phase 2: refusal state). */
export function RefusalCard({ title = "Master data", message }: { title?: string; message?: string }) {
  return (
    <>
      <div className="page-h">
        <h1>{title}</h1>
      </div>
      <div className="card" style={{ maxWidth: 520, padding: 16 }}>
        <p style={{ margin: 0, fontSize: "var(--fs-md, 13px)" }}>
          {message ??
            "Master data is open to Engineering, the Production Head, Planners and Admins. Ask an administrator to give you one of those roles."}
        </p>
      </div>
    </>
  );
}
