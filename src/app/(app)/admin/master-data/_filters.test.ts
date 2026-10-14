import { describe, expect, it } from "vitest";
import { parsePartFamilyFilters, toQueryString } from "./_filters";

describe("parsePartFamilyFilters — the URL is untrusted", () => {
  it("reads valid filters", () => {
    expect(parsePartFamilyFilters({ q: " shell ", scope: "BOTH", status: "DRAFT", group: "Shell", issues: "1" })).toEqual({
      q: "shell", scope: "BOTH", status: "DRAFT", group: "Shell", hasBlockers: true,
    });
  });

  const junk: Array<[string, Record<string, string | string[] | undefined>]> = [
    ["an unknown scope", { scope: "ZZ" }],
    ["lowercase status", { status: "draft" }],
    ["an empty search", { q: "   " }],
    ["issues that is not 1", { issues: "true" }],
    ["an over-long search", { q: "x".repeat(200) }],
  ];
  it.each(junk)("ignores %s without failing", (_n, raw) => {
    expect(parsePartFamilyFilters(raw)).toEqual({});
  });

  it("keeps the valid keys when another is junk, and takes the first of repeated keys", () => {
    expect(parsePartFamilyFilters({ status: "APPROVED", scope: "nope" })).toEqual({ status: "APPROVED" });
    expect(parsePartFamilyFilters({ scope: ["PV", "HE"] })).toEqual({ scope: "PV" });
  });

  it("round-trips through the query string", () => {
    const f = { q: "shell course", scope: "PV" as const, status: "REVIEWED" as const, hasBlockers: true };
    const qs = toQueryString(f);
    expect(qs.startsWith("?")).toBe(true);
    expect(parsePartFamilyFilters(Object.fromEntries(new URLSearchParams(qs)))).toEqual(f);
    expect(toQueryString({})).toBe("");
  });
});
