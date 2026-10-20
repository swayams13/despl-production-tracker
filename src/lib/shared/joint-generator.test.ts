import { describe, expect, it } from "vitest";
import { generateShellJoints } from "./joint-generator";

describe("generateShellJoints", () => {
  it.each([0, -1, 1.5, 31, NaN, Infinity])("refuses %s shell courses", (n) => {
    expect(() => generateShellJoints(n)).toThrow(RangeError);
  });

  it.each([
    [1, ["LS-1"], ["CS-1", "CS-2"]],
    [2, ["LS-1", "LS-2"], ["CS-1", "CS-2", "CS-3"]],
    [3, ["LS-1", "LS-2", "LS-3"], ["CS-1", "CS-2", "CS-3", "CS-4"]],
  ])("%i course(s): long seams LS-1..n, circumferential seams CS-1..n+1", (n, ls, cs) => {
    const joints = generateShellJoints(n);
    expect(joints.filter((j) => j.jointType === "LONG_SEAM").map((j) => j.jointNo)).toEqual(ls);
    expect(joints.filter((j) => j.jointType === "CIRC_SEAM").map((j) => j.jointNo)).toEqual(cs);
    expect(joints.map((j) => j.sortOrder)).toEqual(joints.map((_, i) => i));
    expect(new Set(joints.map((j) => j.jointNo)).size).toBe(joints.length);
  });

  it("describes what each circumferential seam joins", () => {
    const cs = generateShellJoints(3).filter((j) => j.jointType === "CIRC_SEAM");
    expect(cs.map((j) => j.joins)).toEqual([
      "First head to shell course 1",
      "Shell course 1 to course 2",
      "Shell course 2 to course 3",
      "Shell course 3 to second head",
    ]);
  });
});
