import { readdirSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Liveness/readiness probe. Public (middleware.ts's PUBLIC_PATHS) — a
 * deploy platform's health checker has no session cookie, so this cannot go
 * through requireActor()/route() like every other route. Checks DB
 * reachability directly rather than just returning 200 for a running process:
 * a database outage is exactly the failure mode a health check exists to catch.
 *
 * It also reports pending migrations (MERGE-RUNBOOK.md §9 item 7). On 2 Sep 2026
 * production ran new code against the 24 Aug schema for a full day, silently:
 * `SELECT 1` succeeded the whole time, so the old version of this probe was
 * green while every Phase 4/5 page threw. CI cannot catch that — it applies
 * every migration to a throwaway database on every run and always passes. Only
 * a check against the deployed database can, so it lives here.
 */

/**
 * Migration directories on disk that the connected database has not applied.
 *
 * ponytail: a directory listing against `_prisma_migrations`, not
 * `prisma migrate diff`. The CLI needs a shadow database and a subprocess;
 * the failure this exists to catch is a migration that was never applied,
 * which is a difference between two sets of names. `migrate diff` catches the
 * other drift class (an edited migration, a hand-patched schema) and runs in
 * CI instead, where a shadow database is free.
 */
export function pendingMigrations(applied: Iterable<string>): string[] {
  const appliedSet = new Set(applied);
  return readdirSync(path.join(process.cwd(), "prisma", "migrations"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && !appliedSet.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// prisma/migrations/ is read per request, and a static probe would defeat the
// point of probing.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return NextResponse.json({ status: "error", db: "unreachable" }, { status: 503 });
  }

  let pending: string[];
  try {
    // rolled_back_at IS NULL excludes the healed 16 Aug row for
    // 20260815120000, whose successful re-apply is a separate row.
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    pending = pendingMigrations(rows.map((row) => row.migration_name));
  } catch {
    // despl_web's SELECT comes from a blanket ALL TABLES grant, and the app
    // is not the owner of _prisma_migrations — if that ever stops holding,
    // report the gap rather than declaring a working deployment unhealthy.
    return NextResponse.json({ status: "ok", migrations: "unknown" });
  }

  if (pending.length > 0) {
    return NextResponse.json(
      { status: "error", migrations: "pending", pending },
      { status: 503 },
    );
  }

  return NextResponse.json({ status: "ok" });
}
