import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecret } from "@/lib/cron-auth";
import { runAlertReconciliation } from "@/lib/services/cron.service";

/**
 * Hourly cron target (Railway Cron Schedule, configured outside this repo —
 * see docs/superpowers/specs/2026-09-05-scheduler-digest-alerts-design.md).
 * Public in middleware.ts (no browser session exists for a cron caller);
 * self-authenticated via CRON_SECRET instead.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
  }
  const results = await runAlertReconciliation();
  return NextResponse.json({ results });
}
