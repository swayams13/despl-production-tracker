import { describe, expect, it } from "vitest";
import { inspectionMakers } from "./inspection-makers";

/**
 * L1.2g: which WORK steps an INSPECTION step checks. Table-driven, the gate
 * (nothing built yet) and the group-head cases first: these were refused before.
 */
const w = (seq: number, groupCode: string | null, jointRef: string | null = null) => ({ seq, groupCode, jointRef });
const ids = (xs: Array<{ seq: number }>) => xs.map((x) => x.seq);

describe("inspectionMakers", () => {
  it.each([
    ["document gate: no work anywhere before it", { seq: 1, groupCode: "A", jointRef: null }, [w(4, "C")], []],
    ["first in its group, later work in the same group only", { seq: 3, groupCode: "B", jointRef: null }, [w(4, "B"), w(5, "C")], []],
    ["head of a group, work in earlier groups: falls back to the unit's earlier work", { seq: 6, groupCode: "D", jointRef: null }, [w(4, "C"), w(5, "C")], [4, 5]],
    ["fallback ignores later work", { seq: 6, groupCode: "D", jointRef: null }, [w(4, "C"), w(9, "D")], [4]],
  ])("%s", (_l, step, work, expected) => {
    expect(ids(inspectionMakers(step, work))).toEqual(expected);
  });

  it.each([
    ["its group's earlier work wins over earlier groups", { seq: 6, groupCode: "D", jointRef: null }, [w(2, "C"), w(4, "D"), w(5, "D")], [4, 5]],
    ["names a joint: only that joint's work in the group", { seq: 6, groupCode: "D", jointRef: "J1" }, [w(4, "D", "J2"), w(5, "D", "J1")], [5]],
    ["names a joint with a multi-joint maker", { seq: 6, groupCode: "D", jointRef: "J1" }, [w(5, "D", "J1,J2")], [5]],
    ["names a joint, group has work only on other joints: falls back to the unit's earlier work", { seq: 6, groupCode: "D", jointRef: "J1" }, [w(4, "D", "J2")], [4]],
  ])("%s", (_l, step, work, expected) => {
    expect(ids(inspectionMakers(step, work))).toEqual(expected);
  });

  it("does not mutate or reorder its input", () => {
    const work = [w(5, "D"), w(4, "D")];
    const before = JSON.stringify(work);
    inspectionMakers({ seq: 6, groupCode: "D", jointRef: null }, work);
    expect(JSON.stringify(work)).toBe(before);
  });
});
