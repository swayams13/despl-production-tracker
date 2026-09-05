/**
 * Shared-secret guard for the `/api/cron/*` routes. These are added to
 * middleware.ts's PUBLIC_PATHS (a Railway cron caller has no browser
 * session, same reasoning as /api/health) and self-enforce this instead —
 * unlike every other route, there is no Actor/session to check a role
 * against, so the check happens here, before any DB access.
 */
export function isValidCronSecret(
  authHeader: string | null,
  secret: string | undefined = process.env.CRON_SECRET,
): boolean {
  if (!secret) return false;
  return authHeader === `Bearer ${secret}`;
}
