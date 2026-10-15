/**
 * L2.2: the post-login `next` target (set by middleware when it bounces an
 * unauthenticated request to /login). Only a same-origin absolute path is
 * honoured; anything else (scheme, `//host`, backslash tricks, control
 * characters, the login page itself) falls back to the role landing.
 */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) return null;
  return raw;
}
