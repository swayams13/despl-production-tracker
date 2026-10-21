import { describe, expect, it } from "vitest";
import { expandTagList, jointsFromTags, jointTypeFromNo, parseWeldMapGrid, planWeldMap, type ExistingJoint } from "./weld-map";

const HEAD = ["Joint no", "Type", "Joins", "WPS", "NDT extent", "Remarks"];
const codes = (g: Parameters<typeof parseWeldMapGrid>[0]) => parseWeldMapGrid(g).issues.map((i) => i.code);

describe("parseWeldMapGrid", () => {
  it("reads rows under a header found anywhere in the first rows, by name not position", () => {
    const r = parseWeldMapGrid([
      ["WELD MAP V-201"],
      [],
      ["WPS no", "Joint", "joined", "ndt"],
      ["WPS-021", "ls-1", "Shell course 1", "RT 100%"],
      ["WPS-022", "NS-N1", null, null],
    ]);
    expect(r.issues).toEqual([]);
    expect(r.rows).toEqual([
      { row: 4, jointNo: "LS-1", jointType: "LONG_SEAM", typeGiven: false, joins: "Shell course 1", wpsRef: "WPS-021", ndtExtent: "RT 100%" },
      { row: 5, jointNo: "NS-N1", jointType: "NOZZLE", typeGiven: false, joins: null, wpsRef: "WPS-022", ndtExtent: null },
    ]);
  });

  it("accepts header aliases and a given type", () => {
    const r = parseWeldMapGrid([["Weld No", "Joint type", "Description", "WPS ref", "Extent of NDT"], ["SK-1", "Attachment", "Skirt to head", "W1", "MT"]]);
    expect(r.rows[0]).toMatchObject({ jointNo: "SK-1", jointType: "ATTACHMENT", typeGiven: true, joins: "Skirt to head", wpsRef: "W1", ndtExtent: "MT" });
  });

  it.each<[string, Parameters<typeof parseWeldMapGrid>[0], string]>([
    ["no header", [["a", "b"], [1, 2]], "HEADER_NOT_FOUND"],
    ["blank joint number on a row with content", [HEAD, [null, "Nozzle", "x"]], "JOINT_NO_MISSING"],
    ["joint number with a space", [HEAD, ["LS 1"]], "JOINT_NO_INVALID"],
    ["a list in one cell", [HEAD, ["LS-1,LS-2"]], "JOINT_NO_INVALID"],
    ["duplicate joint number (case-insensitive)", [HEAD, ["LS-1"], ["ls-1"]], "JOINT_NO_DUPLICATE"],
    ["bad type", [HEAD, ["LS-1", "weird"]], "TYPE_UNREADABLE"],
    ["header only", [HEAD], "NO_ROWS"],
  ])("refuses: %s", (_n, grid, code) => {
    expect(codes(grid)).toContain(code);
  });

  it("drops only the bad rows and keeps the first of a duplicate", () => {
    const r = parseWeldMapGrid([HEAD, ["LS-1", null, "first"], ["LS-1", null, "second"], [null, null, "orphan"], ["CS-1"]]);
    expect(r.rows.map((x) => [x.jointNo, x.joins])).toEqual([["LS-1", "first"], ["CS-1", null]]);
  });

  it("warns when a typed joint contradicts its prefix, and says remarks are not stored", () => {
    const c = codes([HEAD, ["LS-1", "Nozzle", null, null, null, "note"]]);
    expect(c).toContain("TYPE_PREFIX_MISMATCH");
    expect(c).toContain("REMARKS_NOT_STORED");
  });

  it("skips blank rows and reports unread columns", () => {
    const r = parseWeldMapGrid([[...HEAD, "Welder"], ["LS-1"], [null, null], ["CS-1"]]);
    expect(r.rows).toHaveLength(2);
    expect(r.issues.map((i) => i.code)).toContain("IGNORED_COLUMNS");
  });
});

describe("jointTypeFromNo", () => {
  it.each([
    ["LS-1", "LONG_SEAM"],
    ["CS-2", "CIRC_SEAM"],
    ["NS-N1", "NOZZLE"],
    ["NF-M1", "NOZZLE"],
    ["N4-W1", "NOZZLE"],
    ["M1", "NOZZLE"],
    ["SK-1", "ATTACHMENT"],
    ["BR-SK", "ATTACHMENT"],
    ["GW-3", "ATTACHMENT"],
    ["AT-1", "ATTACHMENT"],
  ])("%s is %s", (n, t) => expect(jointTypeFromNo(n)).toBe(t));
});

describe("expandTagList / jointsFromTags", () => {
  it.each<[string, string[]]>([
    ["N1-N6, M1", ["N1", "N2", "N3", "N4", "N5", "N6", "M1"]],
    ["n1-6", ["N1", "N2", "N3", "N4", "N5", "N6"]],
    ["GW-1…GW-3", ["GW-1", "GW-2", "GW-3"]],
    ["GW-1...3", ["GW-1", "GW-2", "GW-3"]],
    ["GW-1-GW-3", ["GW-1", "GW-2", "GW-3"]],
    ["SK-1\nBR-SK", ["SK-1", "BR-SK"]],
    ["N1, N1, N2", ["N1", "N2"]],
  ])("%j", (input, tags) => expect(expandTagList(input).tags).toEqual(tags));

  it.each([["N6-N1"], ["N1 N2"], ["N1-N500"], ["N#1"]])("refuses %j", (input) => {
    expect(expandTagList(input).errors.length).toBeGreaterThan(0);
  });

  it("nozzle tags become NS- and NF- pairs, once each", () => {
    const r = jointsFromTags("N1-N2, M1", "NOZZLES", true);
    expect(r.joints.map((j) => j.jointNo)).toEqual(["NS-N1", "NF-N1", "NS-N2", "NF-N2", "NS-M1", "NF-M1"]);
    expect(r.joints.every((j) => j.jointType === "NOZZLE")).toBe(true);
    expect(jointsFromTags("NS-N1, N1", "NOZZLES", false).joints.map((j) => j.jointNo)).toEqual(["NS-N1"]);
  });

  it("joint numbers keep what was typed and get a Joins text from the standard prefix", () => {
    const r = jointsFromTags("SK-1, GW-1…GW-2, X-9", "JOINTS", true);
    expect(r.joints.map((j) => [j.jointNo, j.jointType, j.joins])).toEqual([
      ["SK-1", "ATTACHMENT", "Skirt to head"],
      ["GW-1", "ATTACHMENT", "Gusset"],
      ["GW-2", "ATTACHMENT", "Gusset"],
      ["X-9", "ATTACHMENT", null],
    ]);
  });

  it("empty input is an error", () => {
    expect(jointsFromTags("  ", "NOZZLES", true).errors).toHaveLength(1);
  });
});

describe("planWeldMap", () => {
  const ex = (o: Partial<ExistingJoint> & { jointNo: string }): ExistingJoint => ({ jointType: "LONG_SEAM", joins: null, wpsRef: null, ndtExtent: null, confirmed: false, used: 0, ...o });
  const row = (jointNo: string, o: Record<string, unknown> = {}) => ({ row: 2, jointNo, jointType: jointTypeFromNo(jointNo), typeGiven: false, joins: null, wpsRef: null, ndtExtent: null, ...o });

  it("adds new, leaves identical, updates changed, never deletes", () => {
    const p = planWeldMap(
      [row("LS-1"), row("CS-1", { wpsRef: "W2" }), row("NS-N1")],
      [ex({ jointNo: "LS-1" }), ex({ jointNo: "CS-1", jointType: "CIRC_SEAM", wpsRef: "W1" }), ex({ jointNo: "OLD-1" })],
    );
    expect(p.rows.map((r) => r.action)).toEqual(["SAME", "UPDATE", "ADD"]);
    expect(p.rows[1].changes).toEqual([{ field: "wpsRef", from: "W1", to: "W2" }]);
    expect(p.notInFile).toEqual(["OLD-1"]);
    expect(p.counts).toEqual({ add: 1, update: 1, same: 1, refused: 0, notInFile: 1 });
  });

  it("is idempotent: planning a file against the result of applying it is all SAME", () => {
    const file = [row("LS-1", { joins: "Course 1", wpsRef: "W1", ndtExtent: "RT" })];
    const applied = [ex({ jointNo: "LS-1", joins: "Course 1", wpsRef: "W1", ndtExtent: "RT" })];
    expect(planWeldMap(file, applied).rows[0].action).toBe("SAME");
  });

  it("a blank cell never wipes what is on the map", () => {
    const p = planWeldMap([row("LS-1")], [ex({ jointNo: "LS-1", joins: "Course 1", wpsRef: "W1", ndtExtent: "RT" })]);
    expect(p.rows[0]).toMatchObject({ action: "SAME", joins: "Course 1", wpsRef: "W1", ndtExtent: "RT" });
  });

  it("a given type that differs is refused when the joint is used, changed when it is not", () => {
    const used = planWeldMap([row("X-1", { jointType: "NOZZLE", typeGiven: true })], [ex({ jointNo: "X-1", jointType: "ATTACHMENT", used: 3 })]);
    expect(used.rows[0].action).toBe("REFUSED");
    expect(used.rows[0].reason).toContain("X-1");
    expect(used.counts.refused).toBe(1);
    const free = planWeldMap([row("X-1", { jointType: "NOZZLE", typeGiven: true })], [ex({ jointNo: "X-1", jointType: "ATTACHMENT" })]);
    expect(free.rows[0]).toMatchObject({ action: "UPDATE", jointType: "NOZZLE" });
  });

  it("an inferred type never changes an existing joint", () => {
    const p = planWeldMap([row("X-1")], [ex({ jointNo: "X-1", jointType: "NOZZLE", used: 2 })]);
    expect(p.rows[0].action).toBe("SAME");
  });

  it("changing a confirmed joint asks for confirmation again", () => {
    const p = planWeldMap([row("LS-1", { wpsRef: "W9" })], [ex({ jointNo: "LS-1", confirmed: true })]);
    expect(p.rows[0]).toMatchObject({ action: "UPDATE", unconfirms: true });
  });
});
