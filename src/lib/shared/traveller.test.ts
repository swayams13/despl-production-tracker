import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { fallbackLine, resolveOrigin, shortUrl, splitColumns, unitUrl } from "./traveller";

const hdr = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });

describe("resolveOrigin", () => {
  it.each<[string, Record<string, string>, string | undefined, string]>([
    ["APP_URL wins, slash stripped", { host: "x:1" }, "https://tracker.despl.in/", "https://tracker.despl.in"],
    ["blank APP_URL is ignored", { host: "app.example.com" }, "  ", "https://app.example.com"],
    ["forwarded host and proto", { "x-forwarded-host": "tracker.despl.in", "x-forwarded-proto": "https", host: "10.0.0.2:3000" }, undefined, "https://tracker.despl.in"],
    ["first of a forwarded list", { "x-forwarded-host": "a.in, b.in", "x-forwarded-proto": "https, http" }, undefined, "https://a.in"],
    ["localhost defaults to http", { host: "localhost:3000" }, undefined, "http://localhost:3000"],
    ["LAN host with forwarded http", { host: "192.168.1.5:3000", "x-forwarded-proto": "http" }, undefined, "http://192.168.1.5:3000"],
    ["no headers at all", {}, undefined, "http://localhost:3000"],
  ])("%s", (_n, h, env, want) => expect(resolveOrigin(hdr(h), env)).toBe(want));
});

describe("unitUrl / shortUrl", () => {
  it("builds /u/<publicId> and never contains a serial", () => {
    const url = unitUrl("https://t.despl.in/", "3f2a-9c");
    expect(url).toBe("https://t.despl.in/u/3f2a-9c");
    expect(shortUrl(url)).toBe("t.despl.in/u/3f2a-9c");
  });
  it("encodes odd ids", () => expect(unitUrl("http://h", "a b")).toBe("http://h/u/a%20b"));
});

describe("splitColumns", () => {
  it.each([
    [25, 13, 12],
    [24, 12, 12],
    [1, 1, 0],
    [0, 0, 0],
  ])("%i items -> %i + %i", (n, a, b) => {
    const [l, r] = splitColumns(Array.from({ length: n }, (_, i) => i));
    expect([l.length, r.length]).toEqual([a, b]);
  });
});

describe("fallbackLine", () => {
  it("names the unit's serial", () => expect(fallbackLine("320SR05")).toBe("Scan not working? Open /scan and type 320SR05"));
});

describe("QR svg", () => {
  it("renders an inline svg for a unit URL", async () => {
    const svg = await QRCode.toString(unitUrl("https://t.despl.in", "abc"), { type: "svg", margin: 0 });
    expect(svg.startsWith("<svg")).toBe(true);
  });
});
