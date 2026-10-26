import { describe, expect, it } from "vitest";
import { clientIpFromForwardedFor as ip, trustedProxyHops } from "./client-ip";

describe("clientIpFromForwardedFor", () => {
  it.each<[string, string | null | undefined, number, string | null]>([
    ["spoofed leading entries are ignored (1 hop)", "6.6.6.6, 7.7.7.7, 203.0.113.9", 1, "203.0.113.9"],
    ["a spoofed single entry is the proxy-appended one, not trusted beyond hops", "6.6.6.6", 1, "6.6.6.6"],
    ["fewer entries than hops: unknown", "203.0.113.9", 2, null],
    ["no header: unknown", null, 1, null],
    ["empty header: unknown", "", 1, null],
    ["blank entry: unknown", "6.6.6.6, ", 1, null],
    ["2 hops: client is second from the right", "6.6.6.6, 203.0.113.9, 10.0.0.2", 2, "203.0.113.9"],
    ["2 hops, spoofed prefix ignored", "1.1.1.1, 2.2.2.2, 203.0.113.9, 10.0.0.2", 2, "203.0.113.9"],
    ["invalid hops: unknown", "203.0.113.9", 0, null],
    ["whitespace trimmed", "6.6.6.6 ,   203.0.113.9  ", 1, "203.0.113.9"],
  ])("%s", (_n, header, hops, expected) => {
    expect(ip(header, hops)).toBe(expected);
  });
});

describe("trustedProxyHops", () => {
  it.each<[string | undefined, number]>([[undefined, 1], ["", 1], ["0", 1], ["-2", 1], ["abc", 1], ["1.5", 1], ["2", 2]])("%j -> %i", (raw, n) => {
    expect(trustedProxyHops(raw)).toBe(n);
  });
});
