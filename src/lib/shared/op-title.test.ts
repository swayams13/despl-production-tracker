import { describe, expect, it } from "vitest";
import { repeatedOpSuffixes } from "./op-title";

describe("repeatedOpSuffixes", () => {
  it("numbers an operation a route uses twice, in route order, whatever order they arrive in", () => {
    const m = repeatedOpSuffixes([
      { key: 12, group: 1, name: "Forming", seq: 3 },
      { key: 10, group: 1, name: "Cutting", seq: 1 },
      { key: 11, group: 1, name: "Forming", seq: 2 },
    ]);
    expect(m.get(11)).toBe(" (1 of 2)");
    expect(m.get(12)).toBe(" (2 of 2)");
    expect(m.has(10)).toBe(false);
  });

  it("counts per part: the same name on two parts is not a repeat", () => {
    const m = repeatedOpSuffixes([
      { key: 1, group: "A", name: "Machining", seq: 1 },
      { key: 2, group: "B", name: "Machining", seq: 1 },
    ]);
    expect(m.size).toBe(0);
  });

  it("three repeats, and nothing at all when no name repeats", () => {
    const three = repeatedOpSuffixes([2, 3, 4].map((seq) => ({ key: seq, group: 1, name: "Machining", seq })));
    expect([...three.values()]).toEqual([" (1 of 3)", " (2 of 3)", " (3 of 3)"]);
    expect(repeatedOpSuffixes([{ key: 1, group: 1, name: "A", seq: 1 }, { key: 2, group: 1, name: "B", seq: 2 }]).size).toBe(0);
    expect(repeatedOpSuffixes([]).size).toBe(0);
  });
  describe("printed step names", () => {
    const head = (a: string | null, b: string | null) => [
      { key: 2, group: 1, name: "Forming", seq: 2, printed: a },
      { key: 3, group: 1, name: "Forming", seq: 3, printed: b },
    ];
    it("uses the route's own names when every repeat has a distinct one", () => {
      const m = repeatedOpSuffixes(head("Pressing/Spinning", "Trimming"));
      expect(m.get(2)).toBe(" (Pressing/Spinning)");
      expect(m.get(3)).toBe(" (Trimming)");
    });
    it("falls back to numbering when a name is missing, blank or shared", () => {
      for (const [a, b] of [["Pressing", null], ["Pressing", "  "], ["Trimming", "Trimming"]] as const) {
        expect([...repeatedOpSuffixes(head(a, b)).values()]).toEqual([" (1 of 2)", " (2 of 2)"]);
      }
    });
    it("a name used once is still left alone", () => {
      expect(repeatedOpSuffixes([{ key: 1, group: 1, name: "Cutting", seq: 1, printed: "Plate Cutting" }]).size).toBe(0);
    });
  });
});
