import { describe, expect, it } from "vitest";
import { groupByJobNumber } from "./_project-filter";

describe("groupByJobNumber", () => {
  it("counts rows per job number, sorted alphabetically", () => {
    const rows = [{ jobNumber: "DE0467" }, { jobNumber: "DESPL-320" }, { jobNumber: "DE0467" }, { jobNumber: "12548" }];
    expect(groupByJobNumber(rows)).toEqual([
      ["12548", 1],
      ["DE0467", 2],
      ["DESPL-320", 1],
    ]);
  });

  it("returns an empty array for an empty pool", () => {
    expect(groupByJobNumber([])).toEqual([]);
  });

  it("returns a single entry when every row is the same job", () => {
    const rows = [{ jobNumber: "DESPL-320" }, { jobNumber: "DESPL-320" }];
    expect(groupByJobNumber(rows)).toEqual([["DESPL-320", 2]]);
  });
});
