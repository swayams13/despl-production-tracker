import { describe, expect, it } from "vitest";
import { effectiveRequiresQc, pickRouteTemplate, resolveProcessSeq, stepKey } from "./stage-mapping";

describe("resolveProcessSeq — step-level first, then operation-level default", () => {
  const opSeq = new Map([
    [100, 11],
    [200, 12],
  ]);
  const stepSeq = new Map([
    [stepKey(7, 30), 18], // route version 7, step seq 30 -> process 18
  ]);

  // [label, op, expected]
  const cases: Array<[string, { operationId: number; seq: number; routeVersionId: number | null }, number | null]> = [
    ["no step row -> operation-level default (today's rule)", { operationId: 100, seq: 10, routeVersionId: 7 }, 11],
    ["step row overrides the operation-level default", { operationId: 100, seq: 30, routeVersionId: 7 }, 18],
    ["step row applies to an operation with no operation-level mapping", { operationId: 999, seq: 30, routeVersionId: 7 }, 18],
    ["same seq on a different route version is not affected", { operationId: 100, seq: 30, routeVersionId: 8 }, 11],
    ["component with no route version falls back to the operation level", { operationId: 200, seq: 30, routeVersionId: null }, 12],
    ["no row at either level -> null (SEAM, no borrowed number)", { operationId: 999, seq: 10, routeVersionId: 7 }, null],
    ["no route version and no operation mapping -> null", { operationId: 999, seq: 30, routeVersionId: null }, null],
  ];
  it.each(cases)("%s", (_label, op, expected) => {
    expect(resolveProcessSeq(op, stepSeq, opSeq)).toBe(expected);
  });

  it("with an empty step map every operation resolves exactly as the operation-level map says", () => {
    const empty = new Map<string, number>();
    for (const [operationId, seq] of opSeq) {
      expect(resolveProcessSeq({ operationId, seq: 30, routeVersionId: 7 }, empty, opSeq)).toBe(seq);
    }
  });
});

describe("effectiveRequiresQc — either level can waive QC", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])("step %s AND operation %s -> %s", (step, op, expected) => {
    expect(effectiveRequiresQc(step, op)).toBe(expected);
  });
});

describe("pickRouteTemplate — deterministic route pick", () => {
  const t = (id: number, familyId: number | null, variant: string, published: number) => ({
    id,
    familyId,
    variant,
    versions: Array.from({ length: published }, (_, i) => ({ version: i + 1 })),
  });

  it("returns null for no candidates", () => {
    expect(pickRouteTemplate([])).toBeNull();
  });

  const cases: Array<[string, ReturnType<typeof t>[], number]> = [
    ["single candidate", [t(1, 5, "A", 1)], 1],
    ["lowest variant letter wins among published", [t(2, 5, "B", 1), t(1, 5, "A", 1)], 1],
    ["order of arrival does not matter", [t(1, 5, "A", 1), t(2, 5, "B", 1), t(3, 5, "C", 1)], 1],
    ["a variant with a published version beats a lower letter with none", [t(1, 5, "A", 0), t(2, 5, "B", 1)], 2],
    ["family-specific beats generic even when generic has the lower variant", [t(1, null, "A", 1), t(2, 5, "B", 1)], 2],
    ["family-specific beats generic even when it has nothing published (pre-M1 rule kept)", [t(1, null, "A", 1), t(2, 5, "A", 0)], 2],
    ["generic is used when it is the only candidate", [t(1, null, "B", 1), t(2, null, "A", 1)], 2],
  ];
  it.each(cases)("%s", (_label, candidates, expectedId) => {
    expect(pickRouteTemplate(candidates)?.id).toBe(expectedId);
  });
});
