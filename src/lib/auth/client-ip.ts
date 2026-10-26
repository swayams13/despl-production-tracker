/**
 * The caller's address from `x-forwarded-for`, trusting only the proxies we run.
 * Each proxy appends the address it saw, so the entries a caller wrote itself sit
 * on the LEFT and the ones our proxies wrote on the right: with `hops` proxies in
 * front, the client is `hops` entries from the right. Fewer entries than hops, or
 * no header, means we cannot say: null. `x-real-ip` is deliberately never read.
 */
export function clientIpFromForwardedFor(header: string | null | undefined, hops: number): string | null {
  if (!header || !Number.isInteger(hops) || hops < 1) return null;
  const entries = header.split(",");
  const ip = entries[entries.length - hops]?.trim();
  return ip ? ip.slice(0, 64) : null;
}

/** TRUSTED_PROXY_HOPS: how many proxies of ours append to x-forwarded-for. Default 1. */
export function trustedProxyHops(raw: string | undefined = process.env.TRUSTED_PROXY_HOPS): number {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n >= 1 ? n : 1;
}
