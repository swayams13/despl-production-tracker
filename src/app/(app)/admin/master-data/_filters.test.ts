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

import { filterMaterials, materialQueryString, parseMaterialFilters } from "./_filters";

describe("material filters", () => {
  const rows = [
    { spec: "SA 516", grade: "Gr.70", productForm: "Plate", status: "DRAFT", densityGcc: 7.85 },
    { spec: "SA 106", grade: "Gr.B", productForm: "Pipe", status: "APPROVED", densityGcc: null },
    { spec: "IS 2062", grade: "E250", productForm: "Plate", status: "REVIEWED", densityGcc: 7.85 },
  ];

  it("ignores junk in the URL", () => {
    expect(parseMaterialFilters({ status: "weird", nodensity: "yes", q: "  " })).toEqual({});
    expect(parseMaterialFilters({ status: "DRAFT", nodensity: "1", q: "516" })).toEqual({ status: "DRAFT", noDensity: true, q: "516" });
  });

  it("filters by status, missing density and a text search over spec, grade and form", () => {
    expect(filterMaterials(rows, { status: "APPROVED" }).map((r) => r.spec)).toEqual(["SA 106"]);
    expect(filterMaterials(rows, { noDensity: true }).map((r) => r.spec)).toEqual(["SA 106"]);
    expect(filterMaterials(rows, { q: "plate" }).map((r) => r.spec)).toEqual(["SA 516", "IS 2062"]);
    expect(filterMaterials(rows, { q: "gr.b" }).map((r) => r.spec)).toEqual(["SA 106"]);
    expect(filterMaterials(rows, { status: "DRAFT", q: "plate" }).map((r) => r.spec)).toEqual(["SA 516"]);
    expect(filterMaterials(rows, {})).toHaveLength(3);
  });

  it("round-trips through the query string", () => {
    const f = { status: "REVIEWED" as const, noDensity: true, q: "plate" };
    expect(parseMaterialFilters(Object.fromEntries(new URLSearchParams(materialQueryString(f))))).toEqual(f);
    expect(materialQueryString({})).toBe("");
  });
});
