import { describe, expect, it } from "vitest";
import type { HeStageRow, MaterialRow, ParsedWorkbook, PartRow, StepRow } from "./master-import.parse";
import { evaluateMaster, stepSignature, type IssueCode, type ReferenceData } from "./master-import.rules";

const REF: ReferenceData = {
  operationCodes: new Set(["RECEIPT", "CUTTING", "ROLLING", "FIT_UP", "WELDING", "NDT", "INSPECTION"]),
  operationDefaultStage: new Map([["RECEIPT", 10], ["CUTTING", 12], ["ROLLING", 13], ["FIT_UP", 15], ["WELDING", 16], ["NDT", 17], ["INSPECTION", 25]]),
  departmentNames: new Set(["Stores", "Fabrication Prep", "Fabrication / Welding", "Quality Control / QA", "Heat Treatment"]),
  pvStages: new Map([
    [10, { name: "Receipt", department: "Stores" }],
    [12, { name: "Cutting", department: "Fabrication Prep" }],
    [13, { name: "Forming", department: "Fabrication Prep" }],
    [15, { name: "Shell Fit-Up", department: "Fabrication / Welding" }],
    [16, { name: "Shell Welding", department: "Fabrication / Welding" }],
    [17, { name: "Weld NDE", department: "Quality Control / QA" }],
    [19, { name: "Nozzle Fit-Up", department: "Fabrication / Welding" }],
    [20, { name: "Nozzle Welding", department: "Fabrication / Welding" }],
    [21, { name: "PWHT", department: "Heat Treatment" }],
    [25, { name: "Final Inspection", department: "Quality Control / QA" }],
  ]),
};

const part = (over: Partial<PartRow> = {}): PartRow => ({
  row: 5, code: "SHL-01", name: "Shell Course", equipment: "PV + HE", assemblyGroup: "Shell", makeBuy: "Made in-house",
  rawForm: "Plate", typicalMoc: "SA516", dimensions: "", weightBasis: "Rolled shell (ID, T, L)", variants: ["A"], spare: "No",
  routeSource: "Current shop practice", filledBy: "", checkedBy: "", status: "Approved by Production Head", remarks: "", ...over,
});
const step = (over: Partial<StepRow> = {}): StepRow => ({
  row: 5, partCode: "SHL-01", variant: "A", seq: "10", operation: "Receipt", whatIsDone: "", department: "Stores",
  pvStage: "10", heStage: "11", stdTime: "0.5", timeUnit: "Hours", timeBasis: "Per piece", conditional: "No",
  condition: "", acceptance: "", record: "", remarks: "", ...over,
});
const heStage = (over: Partial<HeStageRow> = {}): HeStageRow => ({
  row: 5, heType: "Fixed", stageNo: "11", name: "Receipt", activities: "", department: "Stores", minDays: "1", maxDays: "2",
  predecessors: "—", linkType: "Finish-to-Start", lag: "0", optional: "No", optionalWhen: "", remarks: "", ...over,
});
const material = (over: Partial<MaterialRow> = {}): MaterialRow => ({
  row: 5, spec: "SA 516", grade: "Gr.70", productForm: "Plate", density: "7.85", remarks: "", example: "", ...over,
});

function wb(over: Partial<ParsedWorkbook> = {}): ParsedWorkbook {
  return {
    sheets: [], parts: [part()], steps: [step()], materials: [], heStages: [heStage()], pvStagesRef: [], assembly: [],
    newOperations: [], reviewActions: [], skippedExamples: {}, problems: [], ...over,
  };
}
const run = (over: Partial<ParsedWorkbook>, allowDraft = false) => evaluateMaster(wb(over), REF, { allowDraft });
const codes = (r: ReturnType<typeof run>, severity?: string) =>
  r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);
const has = (r: ReturnType<typeof run>, code: IssueCode, severity?: string) =>
  r.issues.some((i) => i.code === code && (!severity || i.severity === severity));

describe("a clean part loads with no issues", () => {
  it("approved part, valid route, valid HE sheet", () => {
    const r = run({});
    expect(r.issues).toEqual([]);
    expect(r.parts[0].load).toBe(true);
    expect(r.parts[0].variants).toEqual([expect.objectContaining({ variant: "A", load: true })]);
    expect(r.heLoadable).toBe(true);
  });
});

describe("part-level rules (violations first)", () => {
  const cases: Array<[string, Partial<PartRow>, IssueCode]> = [
    ["draft part in production mode", { status: "Draft" }, "NOT_APPROVED"],
    ["reviewed part in production mode", { status: "Reviewed" }, "NOT_APPROVED"],
    ["approved but route source is assumed", { routeSource: "Assumed – to be confirmed" }, "ASSUMED_ROUTE_APPROVED"],
    ["unknown equipment", { equipment: "Boiler" }, "INVALID_VALUE"],
    ["unknown status", { status: "Maybe" }, "INVALID_VALUE"],
  ];
  it.each(cases)("%s: error, part not loaded", (_n, over, code) => {
    const r = run({ parts: [part(over)], steps: [] });
    expect(has(r, code, "ERROR")).toBe(true);
    expect(r.parts[0].load).toBe(false);
  });

  it("duplicate part code is an error", () => {
    expect(has(run({ parts: [part(), part({ row: 6 })], steps: [] }), "DUPLICATE_PART_CODE", "ERROR")).toBe(true);
  });

  it("the duplicate row is dropped, the first row is kept", () => {
    const r = run({ parts: [part({ name: "First" }), part({ row: 6, name: "Second" })] });
    expect(r.parts.map((p) => p.name)).toEqual(["First"]);
  });

  it("allowDraft loads a Draft part (staging) without NOT_APPROVED", () => {
    const r = run({ parts: [part({ status: "Draft", routeSource: "Assumed – to be confirmed" })] }, true);
    expect(codes(r)).not.toContain("NOT_APPROVED");
    expect(r.parts[0]).toMatchObject({ load: true, status: "DRAFT" });
  });

  it("an approved part with a confirmed route source loads", () => {
    for (const src of ["Current shop practice", "Client / QAP requirement", "Code / standard"]) {
      expect(run({ parts: [part({ routeSource: src })] }).parts[0].load).toBe(true);
    }
  });

  it("raw form: known maps to a code, assembly/catalogue maps to none silently, unknown warns and still loads", () => {
    expect(run({ parts: [part({ rawForm: "Plate" })] }).parts[0].rawFormCode).toBe("PLATE");
    const assembly = run({ parts: [part({ rawForm: "Assembly (made of other parts)" })] });
    expect(assembly.parts[0].rawFormCode).toBeNull();
    expect(codes(assembly)).not.toContain("UNKNOWN_RAW_FORM");
    for (const form of ["Pipe fitting", "Bar / Rod"]) {
      const r = run({ parts: [part({ rawForm: form })] });
      expect(has(r, "UNKNOWN_RAW_FORM", "WARNING")).toBe(true);
      expect(r.parts[0]).toMatchObject({ load: true, rawFormCode: null });
    }
  });

  it("an unmapped make/buy is a warning, stored empty", () => {
    const r = run({ parts: [part({ makeBuy: "Outsourced job work" })] });
    expect(has(r, "INVALID_VALUE", "WARNING")).toBe(true);
    expect(r.parts[0]).toMatchObject({ makeBuy: null, load: true });
  });
});

describe("route-step rules (violations first)", () => {
  const blocking: Array<[string, Partial<StepRow>, IssueCode]> = [
    ["unknown operation label", { operation: "Levitation" }, "UNKNOWN_OPERATION"],
    ["operation missing from the tracker", { operation: "Painting / Coating" }, "UNKNOWN_OPERATION"],
    ["blank department", { department: "" }, "MISSING_DEPARTMENT"],
    ["unknown department", { department: "Vendor (outside DESPL)" }, "UNKNOWN_DEPARTMENT"],
    ["missing HE stage on a PV + HE part", { heStage: "" }, "MISSING_STAGE"],
    ["missing PV stage on a PV + HE part", { pvStage: "" }, "MISSING_STAGE"],
    ["PV stage not in the tracker", { pvStage: "99" }, "UNKNOWN_STAGE_NUMBER"],
    ["HE stage not in the sheet", { heStage: "99" }, "UNKNOWN_STAGE_NUMBER"],
    ["non-numeric stage", { pvStage: "10, 11" }, "INVALID_VALUE"],
    ["non-numeric seq", { seq: "ten" }, "INVALID_VALUE"],
    ["lowercase variant", { variant: "a" }, "INVALID_VALUE"],
    ["time with unknown basis", { timeBasis: "Per furlong" }, "UNKNOWN_TIME_BASIS"],
    ["time with unknown unit", { timeUnit: "Fortnights" }, "INVALID_VALUE"],
    ["negative/non-numeric time", { stdTime: "-1" }, "INVALID_VALUE"],
  ];
  it.each(blocking)("%s blocks the variant, not the part", (_n, over, code) => {
    const r = run({ steps: [step(over)] });
    expect(has(r, code, "ERROR")).toBe(true);
    expect(r.parts[0].load).toBe(true);
    if (!(over.variant === "a")) expect(r.parts[0].variants[0].load).toBe(false);
  });

  it("a PV-only part does not need an HE stage, an HE-only part does not need a PV stage", () => {
    expect(codes(run({ parts: [part({ equipment: "PV" })], steps: [step({ heStage: "" })] }))).toEqual([]);
    const he = run({ parts: [part({ equipment: "HE" })], steps: [step({ pvStage: "" })] });
    expect(codes(he, "ERROR")).toEqual([]);
  });

  it("duplicate (part, variant, seq) blocks the variant", () => {
    const r = run({ steps: [step(), step({ row: 6 })] });
    expect(has(r, "DUPLICATE_STEP", "ERROR")).toBe(true);
    expect(r.parts[0].variants[0].load).toBe(false);
  });

  it("a route for a part that is not in the master is reported", () => {
    const r = run({ steps: [step({ partCode: "GHOST-01" })] });
    expect(has(r, "UNKNOWN_PART", "ERROR")).toBe(true);
  });

  it("routes load atomically per variant: a bad B does not block A", () => {
    const r = run({
      parts: [part({ variants: ["A", "B"] })],
      steps: [step({ variant: "A" }), step({ row: 6, variant: "B", department: "" })],
    });
    expect(r.parts[0].variants.map((v) => [v.variant, v.load])).toEqual([["A", true], ["B", false]]);
  });

  const warnings: Array<[string, Partial<StepRow>, IssueCode]> = [
    ["blank standard time", { stdTime: "", timeUnit: "", timeBasis: "" }, "MISSING_STD_TIME"],
    ["proposed standard time", { remarks: "PROPOSED TIME / STAGE — validate" }, "PROPOSED_STD_TIME"],
    ["stage differs from the operation default", { operation: "Fit-up", department: "Fabrication / Welding", pvStage: "19", heStage: "11" }, "STAGE_DIFFERS_FROM_OPERATION_DEFAULT"],
    ["step department differs from the stage department", { operation: "Inspection", department: "Quality Control / QA", pvStage: "21", heStage: "11" }, "DEPARTMENT_STAGE_MISMATCH"],
  ];
  it.each(warnings)("%s is a warning and the variant still loads", (_n, over, code) => {
    const r = run({ steps: [step(over)] });
    expect(has(r, code, "WARNING")).toBe(true);
    expect(codes(r, "ERROR")).toEqual([]);
    expect(r.parts[0].variants[0].load).toBe(true);
  });

  it("flags the Fit-up→19 / Welding→20 / Inspection→21 fill-down pattern once per variant", () => {
    const r = run({
      steps: [
        step({ seq: "10", operation: "Fit-up", department: "Fabrication / Welding", pvStage: "19", heStage: "11" }),
        step({ row: 6, seq: "20", operation: "Welding", department: "Fabrication / Welding", pvStage: "20", heStage: "11" }),
        step({ row: 7, seq: "30", operation: "Inspection", department: "Quality Control / QA", pvStage: "21", heStage: "11" }),
      ],
    });
    expect(r.issues.filter((i) => i.code === "POSSIBLE_FILL_DOWN")).toHaveLength(1);
    expect(r.parts[0].variants[0].load).toBe(true);
  });

  it("does not flag fill-down when the stages differ per operation", () => {
    const r = run({
      steps: [
        step({ seq: "10", operation: "Fit-up", department: "Fabrication / Welding", pvStage: "15", heStage: "11" }),
        step({ row: 6, seq: "20", operation: "Welding", department: "Fabrication / Welding", pvStage: "16", heStage: "11" }),
        step({ row: 7, seq: "30", operation: "Inspection", department: "Quality Control / QA", pvStage: "25", heStage: "11" }),
      ],
    });
    expect(codes(r)).not.toContain("POSSIBLE_FILL_DOWN");
  });
});

describe("variants and routeless parts", () => {
  it("declared variants that have no steps are a gap", () => {
    expect(has(run({ parts: [part({ variants: ["A", "B"] })] }), "VARIANT_GAP", "WARNING")).toBe(true);
  });
  it("present letters that skip one (A, C) are a gap", () => {
    const r = run({ steps: [step(), step({ row: 6, variant: "C" })], parts: [part({ variants: ["A", "C"] })] });
    expect(has(r, "VARIANT_GAP", "WARNING")).toBe(true);
  });
  it("a made-in-house part with no route is a warning; a bought-out part is info", () => {
    expect(has(run({ steps: [] }), "PART_WITHOUT_ROUTE", "WARNING")).toBe(true);
    expect(has(run({ steps: [], parts: [part({ makeBuy: "Bought-out" })] }), "PART_WITHOUT_ROUTE", "INFO")).toBe(true);
  });
});

describe("material master", () => {
  it("rejects a duplicate key (case-insensitive) and a non-positive density", () => {
    const r = run({ materials: [material(), material({ row: 6, spec: "sa 516" }), material({ row: 7, grade: "Gr.60", density: "0" })] });
    expect(has(r, "DUPLICATE_MATERIAL", "ERROR")).toBe(true);
    expect(r.materials.map((m) => m.load)).toEqual([true, false]);
    expect(has(r, "INVALID_VALUE", "ERROR")).toBe(true);
  });
  it("a blank grade is fine; a blank density is a warning and still loads", () => {
    const r = run({ materials: [material({ grade: "", density: "" })] });
    expect(has(r, "MISSING_DENSITY", "WARNING")).toBe(true);
    expect(r.materials[0]).toMatchObject({ load: true, densityGcc: null, grade: "" });
  });
});

describe("HE stages", () => {
  it("loads a valid sheet, reading '—' and lists of predecessors", () => {
    const r = run({
      heStages: [
        heStage({ stageNo: "11", predecessors: "—" }),
        heStage({ row: 6, stageNo: "12", predecessors: "11" }),
        heStage({ row: 7, stageNo: "13", predecessors: "11, 12", linkType: "Start-to-Start (overlap allowed)" }),
      ],
    });
    expect(r.heLoadable).toBe(true);
    expect(r.heStages.find((s) => s.stageNo === 13)).toMatchObject({ predecessors: [11, 12], linkType: "START_TO_START_WITH_OVERLAP" });
  });
  const bad: Array<[string, HeStageRow[], IssueCode]> = [
    ["duplicate stage", [heStage(), heStage({ row: 6 })], "DUPLICATE_STAGE"],
    ["unknown predecessor", [heStage({ predecessors: "99" })], "UNKNOWN_PREDECESSOR"],
    ["unknown department", [heStage({ department: "Mars" })], "UNKNOWN_DEPARTMENT"],
    ["min greater than max", [heStage({ minDays: "5", maxDays: "2" })], "INVALID_VALUE"],
    ["unknown link type", [heStage({ linkType: "Finish-to-Finish" })], "INVALID_VALUE"],
  ];
  it.each(bad)("%s makes the template not loadable (all or nothing)", (_n, stages, code) => {
    const r = run({ heStages: stages });
    expect(has(r, code, "ERROR")).toBe(true);
    expect(r.heLoadable).toBe(false);
  });
});

describe("report-only sheets", () => {
  it("assembly steps citing a part code that is not in the master are warned", () => {
    const r = run({
      assembly: [{ row: 5, equipmentType: "PV", groupCode: "E", stepNo: "4.1", activity: "Fit shell", partsUsed: "SHL-01, GHO-09", jointRef: "", department: "", stage: "" }],
    });
    expect(r.issues.filter((i) => i.code === "ASSEMBLY_UNKNOWN_PART").map((i) => i.meta?.partCode)).toEqual(["GHO-09"]);
  });
  it("new operations and open review actions are info; closed actions are not reported", () => {
    const r = run({
      newOperations: [{ row: 5, name: "Forging", usedIn: "FLG-01", department: "Vendor", why: "" }],
      reviewActions: [
        { row: 5, id: "Q-01", category: "x", issue: "Open one", owner: "PH", status: "Open" },
        { row: 6, id: "Q-02", category: "x", issue: "Done one", owner: "PH", status: "Closed" },
      ],
    });
    expect(codes(r, "INFO").sort()).toEqual(["NEW_OPERATION_PENDING", "REVIEW_ACTION_OPEN"]);
  });
  it("parse problems surface as errors", () => {
    const r = run({ problems: [{ sheet: "Part Routes", row: null, code: "SHEET_MISSING", message: "missing" }] });
    expect(has(r, "SHEET_MISSING", "ERROR")).toBe(true);
  });
});

describe("stepSignature", () => {
  const base = { seq: 10, operationCode: "CUTTING", department: "Fabrication Prep", stdTime: 0.3, stdTimeUnit: "HOURS", stdTimeBasis: "PER_METRE_CUT", conditionText: "", acceptanceStandard: "", recordDocument: "", pvStage: 12, heStage: 13 };
  it("is equal for equal steps and changes with time, stage or department", () => {
    expect(stepSignature(base)).toBe(stepSignature({ ...base }));
    for (const change of [{ stdTime: 0.4 }, { pvStage: 13 }, { heStage: null }, { department: "Stores" }]) {
      expect(stepSignature({ ...base, ...change })).not.toBe(stepSignature(base));
    }
  });
  it("treats a Decimal-like string time and a number time alike", () => {
    expect(stepSignature({ ...base, stdTime: Number("0.30") })).toBe(stepSignature(base));
  });
});
