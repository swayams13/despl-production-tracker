import Link from "next/link";

export default function AppNotFound() {
  return (
    <div className="page-h" style={{ flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
      <h1>Page not found</h1>
      <div className="card" style={{ maxWidth: 480, padding: 16 }}>
        <p style={{ margin: "0 0 12px", color: "var(--muted)", fontSize: 13 }}>
          That page doesn&apos;t exist, or you don&apos;t have access to it.
        </p>
        <Link href="/" className="btn btn-accent">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
