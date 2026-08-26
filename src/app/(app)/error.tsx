"use client";

// Next requires error.tsx to be a Client Component. `error.digest` is Next's
// own correlation id for a Server Component render failure — logged
// server-side already, so surfacing it here is what makes "findable in logs
// within two minutes" (Phase 0 acceptance) actually true for a support
// conversation, not just for someone reading raw server logs.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page-h" style={{ flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
      <h1>Something went wrong</h1>
      <div className="card" style={{ maxWidth: 480, padding: 16 }}>
        <p style={{ margin: "0 0 12px", color: "var(--muted)", fontSize: 13 }}>
          This page hit an unexpected error. Try again — if it keeps happening, report it with the
          reference below.
        </p>
        {error.digest && (
          <p className="mono" style={{ margin: "0 0 12px", fontSize: 11, color: "var(--muted)" }}>
            Reference: {error.digest}
          </p>
        )}
        <button type="button" className="btn btn-accent" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
