/**
 * Next.js instrumentation hook — runs once when the server boots, before it
 * accepts requests. This is where the DB-role guard belongs: it must run at
 * startup, never at module import time (importing db.ts must stay side-effect
 * free, or `next build` and the pure unit-test suite both break).
 *
 * Failure is fatal by design — let it throw out of register() so a
 * misconfigured deployment crashes loudly instead of running with tenant RLS
 * and the append-only audit invariant silently disabled.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertDbRole } = await import("@/lib/db-guard");
    await assertDbRole();
  }
}
