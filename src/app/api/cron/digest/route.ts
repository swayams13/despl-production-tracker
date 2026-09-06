import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecret } from "@/lib/cron-auth";
import { runDailyDigest } from "@/lib/services/cron.service";

/**
 * Daily cron target, 6:30 AM IST / 01:00 UTC (Railway Cron Schedule,
 * configured outside this repo — see
 * docs/superpowers/specs/2026-09-05-scheduler-digest-alerts-design.md).
 * Public in middleware.ts; self-authenticated via CRON_SECRET.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
  }
  const results = await runDailyDigest();
  return NextResponse.json({ results });
}
