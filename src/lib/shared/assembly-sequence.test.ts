import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseMasterWorkbook } from "@/lib/services/master-import.parse";
import {
  classifyJointRef,
  inferRole,
  isSeamDriven,
  mapAssemblySequence,
  normName,
  sequenceSignature,
  type SequenceContext,
  type SequenceRowInput,
} from "./assembly-sequence";

const DEPTS = new Map([
  ["fabrication / welding", 9],
  ["quality control / qa", 6],
  ["heat treatment", 10],
  ["surface treatment & painting", 11],
  ["documentation / mdr", 12],
]);
const ctx = (over: Partial<SequenceContext> = {}): SequenceContext => ({
  departmentIdByName: DEPTS,
  processCodes: new Set(Array.from({ length: 36 }, (_, i) => i + 1)),
  pressureParts: new Set(["SHL-01", "HED-01"]),
  ...over,
});
let n = 0;
const row = (over: Partial<SequenceRowInput> = {}): SequenceRowInput => ({
  row: 10 + ++n,
  groupCode: "G1",
  groupName: "Group",
  stepNo: "1.1",
  seq: String(n * 10),
  activity: "Do something",
  kind: "Work",
  partsUsed: "",
  jointRef: "",
  department: "Fabrication / Welding",
  stage: "16",
  ...over,
});
const map = (rows: SequenceRowInput[], c = ctx()) => mapAssemblySequence(rows, c);
const errors = (r: ReturnType<typeof map>) => r.issues.filter((i) => i.severity === "ERROR").map((i) => i.code);

describe("classifyJointRef (joint reference -> scope selector)", () => {
  it.each([
    ["", "NONE", null],
    ["LS-1", "JOINT", "LONG_SEAM"],
    ["ls-3", "JOINT", "LONG_SEAM"],
    ["CS-2", "JOINT", "CIRC_SEAM"],
    ["CS-1 / CS-2", "JOINT", "CIRC_SEAM"],
    ["NS-N1…N6 / NS-M1", "JOINT", "NOZZLE"],
    ["NF-N2", "JOINT", "NOZZLE"],
    ["N4", "JOINT", "NOZZLE"],
    ["M1", "JOINT", "NOZZLE"],
    ["SK-1", "JOINT", "ATTACHMENT"],
    ["BR-SK / GW-1…32", "JOINT", "ATTACHMENT"],
    ["GW-1...32", "JOINT", "ATTACHMENT"],
    ["LS-1 / CS-1", "MIXED", null],
    ["Pressure weld map", "UNKNOWN", null],
    ["NW-N4/N5/N6", "UNKNOWN", null], // NW- is not in the convention: never guessed
    ["LS-SK", "UNKNOWN", null],
  ])("%j -> %s %s", (cell, kind, type) => {
    const c = classifyJointRef(cell);
    expect(c.kind).toBe(kind);
    if (c.kind === "JOINT") expect(c.jointType).toBe(type);
  });
});

describe("inferRole (provisional keyword rules)", () => {
  it.each([
    ["WORK", "L' Seam Set Up Of Shell (LS-1) Along With PTC", "FIT_UP"],
    ["WORK", "Fit top dished end to shell", "FIT_UP"],
    ["WORK", "Weld Long Seam Of Shell (LS-1)", "WELD"],
    ["WORK", "Fit and weld bottom dished end to shell", "WELD"],
    ["INSPECTION", "Weld Visual Of LS-1", "NDT"],
    ["INSPECTION", "PAUT/TOFD Of LS-1", "NDT"],
    ["INSPECTION", "Perform required RT/PT and dimensional inspection", "NDT"],
    ["WORK", "MPT Of All Weld Joint", "NDT"],
    ["INSPECTION", "Perform post-PWHT NDE, hardness and visual checks", "NDT"],
    ["WORK", "Perform PWHT of the vessel", "FINAL_PWHT"],
    ["WORK", "Perform post-forming heat treatment", "HEAT_TREATMENT"],
    ["INSPECTION", "Simulation heat treatment of test coupon", "HEAT_TREATMENT"],
    ["INSPECTION", "Hydrotest at approved pressure and hold time", "HYDRO"],
    // not a role: a gate, an after-the-fact job, a document
    ["INSPECTION", "Clearance Before PWHT", null],
    ["WORK", "Before Hydrostatic Test Clearance", null],
    ["WORK", "Drain, dry and preserve vessel after hydrotest", null],
    ["INSPECTION", "Compile MTC, weld/NDE/PWHT/hydro records and release documents", null],
    ["INSPECTION", "Verify vessel dimensions and verticality", null],
    ["INSPECTION", "Inspection of weld preparation", null], // an inspection is never FIT_UP or WELD
    ["WORK", "Prepare N1 inlet flange and reinforcement pad assembly", null],
  ] as const)("%s %j -> %s", (kind, activity, role) => {
    expect(inferRole(kind, activity)).toBe(role);
  });
});

describe("mapAssemblySequence — refusals first", () => {
  it.each([
    ["unknown department", { department: "Welding Shop" }, "DEPARTMENT_UNKNOWN"],
    ["unknown process", { stage: "99" }, "PROCESS_UNKNOWN"],
    ["non-numeric process", { stage: "sixteen" }, "PROCESS_UNKNOWN"],
    ["unknown kind", { kind: "Check" }, "KIND_UNKNOWN"],
    ["blank group code", { groupCode: " " }, "GROUP_CODE_BLANK"],
    ["mixed joint types in one cell", { jointRef: "LS-1 / CS-1" }, "JOINT_REF_MIXED"],
  ] as const)("%s refuses the row", (_n, over, code) => {
    const r = map([row(), row(over)]);
    expect(errors(r)).toEqual([code]);
    expect(r.steps).toHaveLength(1); // the good row maps, the bad one is left out
  });

  it("a sheet whose every row is refused is an error, not a silent empty version", () => {
    const r = map([row({ kind: "x" })]);
    expect(errors(r)).toContain("KIND_UNKNOWN");
    expect(r.steps).toEqual([]);
    expect(map([]).steps).toEqual([]); // no rows at all is the service's message ("no rows for this type")
  });

  it("the department name matches without regard to case or spacing", () => {
    expect(errors(map([row({ department: "  QUALITY  control / QA " })]))).toEqual([]);
    expect(normName("  QUALITY  control / QA ")).toBe("quality control / qa");
  });
});

describe("mapAssemblySequence — mapping rules", () => {
  it.each([
    ["Work", "WORK"],
    ["work", "WORK"],
    ["Inspection", "INSPECTION"],
  ] as const)("kind %s -> %s", (kind, expected) => {
    expect(map([row({ kind, department: "Quality Control / QA" })]).steps[0].kind).toBe(expected);
  });

  it("department becomes the seeded id, and 'counts toward stage' the lead-time process", () => {
    const [s] = map([row({ department: "Heat Treatment", stage: "21" })]).steps;
    expect(s).toMatchObject({ defaultDepartmentId: 10, leadTimeProcessSeq: 21 });
  });

  it("a blank stage leaves the process empty without an issue", () => {
    const r = map([row({ stage: "" })]);
    expect(r.steps[0].leadTimeProcessSeq).toBeNull();
    expect(errors(r)).toEqual([]);
  });

  it.each([
    ["", "PER_UNIT", null],
    ["LS-1", "PER_JOINT", "LONG_SEAM"],
    ["CS-2", "PER_JOINT", "CIRC_SEAM"],
    ["NS-N1…N6 / NS-M1", "PER_JOINT", "NOZZLE"],
    ["NF-M1", "PER_JOINT", "NOZZLE"],
    ["N3", "PER_JOINT", "NOZZLE"],
    ["SK-1", "PER_JOINT", "ATTACHMENT"],
    ["BR-SK", "PER_JOINT", "ATTACHMENT"],
    ["GW-1…32", "PER_JOINT", "ATTACHMENT"],
    ["Pressure weld map", "PER_UNIT", null],
  ] as const)("joint ref %j -> %s %s", (jointRef, scope, jointType) => {
    const [s] = map([row({ jointRef })]).steps;
    expect({ scope: s.scope, jointType: s.jointType }).toEqual({ scope, jointType });
  });

  it("an unrecognised joint reference warns and does not refuse", () => {
    const r = map([row({ jointRef: "Pressure weld map" })]);
    expect(errors(r)).toEqual([]);
    expect(r.issues.some((i) => i.code === "JOINT_REF_UNRECOGNISED")).toBe(true);
  });

  it("a PER_JOINT step names no joint in its activity (the floor row carries the joint)", () => {
    const [s] = map([row({ activity: "Weld Long Seam Of Shell (LS-1)", jointRef: "LS-1" })]).steps;
    expect(s.activity).toBe("Weld Long Seam Of Shell");
    const [t] = map([row({ activity: "Weld Visual Of LS-1", jointRef: "LS-1", kind: "Inspection", department: "Quality Control / QA" })]).steps;
    expect(t.activity).toBe("Weld Visual Of the joint");
  });

  it("pressure part: an approved pressure-retaining part code, or a pressure joint type", () => {
    const flags = (partsUsed: string, jointRef = "") => map([row({ partsUsed, jointRef })]).steps[0].pressurePart;
    expect(flags("SHL-01")).toBe(true);
    expect(flags("Accepted shell course + HED-01")).toBe(true);
    expect(flags("PAD-01")).toBe(false); // not in the approved pressure set
    expect(flags("", "")).toBe(false);
    expect(flags("", "CS-1")).toBe(true);
    expect(flags("", "NS-N1")).toBe(true);
    expect(flags("", "SK-1")).toBe(true); // skirt-to-head (D3)
    expect(flags("", "GW-1…32")).toBe(false); // gussets are not pressure parts
  });

  it("requiresQc is true and the QC plan sr no is blank (D3 derives at materialisation)", () => {
    const r = map([row({ kind: "Inspection", department: "Quality Control / QA" })]);
    expect(r.steps[0]).toMatchObject({ requiresQc: true, qcpSrNo: null });
    expect(r.issues.some((i) => i.code === "INSPECTION_UNBOUND")).toBe(true);
  });

  it("steps are numbered 1..n in the sheet's Seq order, not row order", () => {
    const r = map([row({ seq: "30", activity: "C" }), row({ seq: "10", activity: "A" }), row({ seq: "20", activity: "B" })]);
    expect(r.steps.map((s) => [s.seq, s.activity])).toEqual([[1, "A"], [2, "B"], [3, "C"]]);
  });

  it("falls back to sheet order, with a warning, when Seq is not numeric", () => {
    const r = map([row({ seq: "", activity: "A" }), row({ seq: "x", activity: "B" })]);
    expect(r.steps.map((s) => s.activity)).toEqual(["A", "B"]);
    expect(r.issues.some((i) => i.code === "SEQ_NOT_NUMERIC")).toBe(true);
  });

  it("flags a step that covers forming heat treatment and PWHT at once", () => {
    const r = map([row({ activity: "Perform post-forming heat treatment and PWHT", department: "Heat Treatment", stage: "21" })]);
    expect(r.steps[0].role).toBe("FINAL_PWHT");
    expect(r.issues.some((i) => i.code === "ROLE_AMBIGUOUS")).toBe(true);
  });

  it("isSeamDriven is true only for PER_JOINT long/circ seams", () => {
    const seam = map([row({ jointRef: "LS-1" })]).steps[0];
    const nozzle = map([row({ jointRef: "NS-N1" })]).steps[0];
    const unit = map([row()]).steps[0];
    expect([seam, nozzle, unit].map(isSeamDriven)).toEqual([true, false, false]);
  });
});

describe("mapAssemblySequence — collapse of per-joint rows", () => {
  const ls = (no: number, over: Partial<SequenceRowInput> = {}) =>
    row({ activity: `Weld Long Seam Of Shell (LS-${no})`, jointRef: `LS-${no}`, ...over });

  it("consecutive rows that differ only by joint number become one PER_JOINT row, and say so", () => {
    const r = map([ls(1), ls(2), ls(3)]);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ scope: "PER_JOINT", jointType: "LONG_SEAM", activity: "Weld Long Seam Of Shell" });
    expect(r.steps[0].sourceRows).toHaveLength(3);
    expect(r.collapses).toEqual([{ activity: "Weld Long Seam Of Shell", jointRefs: ["LS-1", "LS-2", "LS-3"], rows: r.steps[0].sourceRows }]);
  });

  it("does not collapse when the activity, kind, department or joint type differs", () => {
    expect(map([ls(1), ls(2, { activity: "Weld Visual Of LS-2" })]).steps).toHaveLength(2);
    expect(map([ls(1), ls(2, { kind: "Inspection" })]).steps).toHaveLength(2);
    expect(map([ls(1), ls(2, { department: "Quality Control / QA" })]).steps).toHaveLength(2);
    expect(map([ls(1), row({ activity: "Weld Long Seam Of Shell (CS-1)", jointRef: "CS-1" })]).steps).toHaveLength(2);
  });

  it("does not collapse non-consecutive rows, and warns that the step repeats", () => {
    const r = map([ls(1), row({ activity: "Hold point" }), ls(2)]);
    expect(r.steps).toHaveLength(3);
    expect(r.issues.some((i) => i.code === "JOINT_STEP_REPEATED")).toBe(true);
  });

  it("does not collapse two identical rows for the same joint", () => {
    expect(map([ls(1), ls(1)]).steps).toHaveLength(2);
  });

  it("a collapse keeps a pressure flag set by any of its rows", () => {
    const r = map([ls(1, { partsUsed: "" }), ls(2, { partsUsed: "SHL-01" })], ctx());
    expect(r.steps[0].pressurePart).toBe(true);
  });
});

describe("sequenceSignature", () => {
  it("is equal for equal content and ignores source rows", () => {
    const a = map([row({ seq: "10", activity: "A" })]).steps;
    const b = map([row({ seq: "10", activity: "A" })]).steps;
    expect(sequenceSignature(a)).toBe(sequenceSignature(b));
    expect(sequenceSignature(a)).not.toBe(sequenceSignature(map([row({ activity: "B" })]).steps));
  });
});

// The workbook's own rows: an explicit M2 fixture, never copied into seeds.
describe("the 11 Oct workbook, 'HP Air Receiver Blow Down Vessel' rows (explicit fixture)", () => {
  const file = path.resolve(__dirname, "../../../docs/lean-core/inputs/2026-10-11-master-list/Standard_Parts_Master_PV_HE_SAMPLE.xlsx");
  it.skipIf(!existsSync(file))("maps all 31 rows with no errors", () => {
    const wb = parseMasterWorkbook(readFileSync(file));
    const rows = wb.assembly.filter((r) => r.equipmentType === "HP Air Receiver Blow Down Vessel");
    expect(rows).toHaveLength(31);
    expect(rows[0]).toMatchObject({ groupCode: "PV-S1", groupName: "Shell Course", stepNo: "1.1", seq: "10", kind: "Work", jointRef: "LS-1", department: "Fabrication / Welding", stage: "15" });
    const r = map(rows, ctx({ pressureParts: new Set(["SHL-01", "HED-01", "NOZ-01"]) }));
    expect(errors(r)).toEqual([]);
    expect(r.steps).toHaveLength(31);
    expect(r.steps.map((s) => s.seq)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    const by = (re: RegExp) => r.steps.find((s) => re.test(s.activity))!;
    expect(by(/^Roll and fit shell/)).toMatchObject({ scope: "PER_JOINT", jointType: "LONG_SEAM", role: "FIT_UP", kind: "WORK", pressurePart: true });
    expect(by(/^Weld top dished end/)).toMatchObject({ jointType: "CIRC_SEAM", role: "WELD" });
    expect(by(/^Perform RT\/PT of head/)).toMatchObject({ jointType: "CIRC_SEAM", role: "NDT", kind: "INSPECTION" });
    expect(by(/^Weld nozzles\/manhole/)).toMatchObject({ jointType: "NOZZLE", role: "WELD", leadTimeProcessSeq: 20 });
    expect(by(/^Fit base ring/)).toMatchObject({ jointType: "ATTACHMENT", scope: "PER_JOINT" });
    expect(by(/^Prepare N1/)).toMatchObject({ scope: "PER_UNIT" }); // NW-N1 is not a known joint prefix
    expect(by(/^Hydrotest/)).toMatchObject({ role: "HYDRO", leadTimeProcessSeq: 27 });
    expect(by(/^Drain, dry/).role).toBeNull();
    expect(by(/^Compile MTC/).role).toBeNull();
    expect(r.steps.filter(isSeamDriven)).toHaveLength(7);
  });
});
