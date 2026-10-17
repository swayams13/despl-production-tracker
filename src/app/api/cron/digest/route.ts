import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecret } from "@/lib/cron-auth";
import { runDailyDigest } from "@/lib/services/cron.service";

/**
 * Daily cron target. L2.11: 08:30 IST / 03:00 UTC (`0 3 * * *`), the time the
 * morning digest email goes out; it was 06:30 IST / 01:00 UTC before. The
 * Railway Cron Schedule is configured outside this repo, so the schedule is
 * changed in the dashboard (see
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
