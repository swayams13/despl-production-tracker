/**
 * Lean Core L2.9: pure helpers for the unit traveller (A5 print view).
 * The QR carries /u/<publicId>, never the serial (build prompt §8.2 item 16).
 */

export interface HeaderLike {
  get(name: string): string | null;
}

/**
 * Public origin of this deployment. `APP_URL` wins when set; otherwise the
 * proxy's forwarded host/proto, then plain host. Trailing slash stripped.
 */
export function resolveOrigin(h: HeaderLike, appUrl?: string | null): string {
  const env = appUrl?.trim();
  if (env) return env.replace(/\/+$/, "");
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") ?? (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https")).split(",")[0].trim();
  return `${proto}://${host}`;
}

export function unitUrl(origin: string, publicId: string): string {
  return `${origin.replace(/\/+$/, "")}/u/${encodeURIComponent(publicId)}`;
}

/** The text printed under the QR: the URL without its scheme. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** Split a list into two print columns, the first taking the extra row (25 -> 13 + 12). */
export function splitColumns<T>(items: readonly T[]): [T[], T[]] {
  const n = Math.ceil(items.length / 2);
  return [items.slice(0, n), items.slice(n)];
}

export function fallbackLine(serialNo: string): string {
  return `Scan not working? Open /scan and type ${serialNo}`;
}
