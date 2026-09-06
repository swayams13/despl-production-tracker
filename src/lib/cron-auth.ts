import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret guard for the `/api/cron/*` routes. These are added to
 * middleware.ts's PUBLIC_PATHS (a Railway cron caller has no browser
 * session, same reasoning as /api/health) and self-enforce this instead —
 * unlike every other route, there is no Actor/session to check a role
 * against, so the check happens here, before any DB access.
 *
 * Uses constant-time comparison to prevent timing side-channels.
 */
export function isValidCronSecret(
  authHeader: string | null,
  secret: string | undefined = process.env.CRON_SECRET,
): boolean {
  if (!secret || !authHeader) return false;

  const expectedHeader = `Bearer ${secret}`;

  // Check length first to avoid passing buffers of different lengths to timingSafeEqual
  if (authHeader.length !== expectedHeader.length) return false;

  try {
    return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expectedHeader));
  } catch {
    return false;
  }
}
