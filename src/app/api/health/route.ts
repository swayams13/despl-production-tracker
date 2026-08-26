import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Liveness/readiness probe. Public (middleware.ts's PUBLIC_PATHS) — a
 * deploy platform's health checker has no session cookie, so this cannot go
 * through requireActor()/route() like every other route. Checks DB
 * reachability directly rather than just returning 200 for a running process:
 * a database outage is exactly the failure mode a health check exists to catch.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
