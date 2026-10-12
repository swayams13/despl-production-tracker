import { describe, expect, it } from "vitest";
import type { NormalStep, ReferenceData } from "./master-import.rules";
import { evaluateReadiness, type VariantState } from "./master-data.readiness";

const REF: ReferenceData = {
  operationCodes: new Set(["RECEIPT", "FIT_UP", "INSPECTION"]),
  operationDefaultStage: new Map([["RECEIPT", 10], ["FIT_UP", 15], ["INSPECTION", 25]]),
  departmentNames: new Set(["Stores", "Fabrication / Welding", "Quality Control / QA"]),
  componentTypeCodes: new Set(["PLATE"]),
  pvStages: new Map([
    [10, { name: "Receipt", department: "Stores" }],
    [15, { name: "Fit-up", department: "Fabrication / Welding" }],
    [25, { name: "Final inspection", department: "Quality Control / QA" }],
  ]),
};
const HE = new Map([[11, { department: "Stores" }]]);

const step = (over: Partial<NormalStep> = {}): NormalStep => ({
  row: 0, seq: 10, operationCode: "RECEIPT", whatIsDone: "", department: "Stores", pvStage: 10, heStage: null,
  stdTime: 0.5, stdTimeUnit: "HOURS", stdTimeBasis: "PER_PIECE", conditional: false, conditionText: "",
  acceptanceStandard: "", recordDocument: "", requiresQc: true, ...over,
});
const variant = (over: Partial<VariantState> = {}): VariantState => ({ variant: "A", version: 1, status: "DRAFT", steps: [step()], ...over });
const part = (over: { scope?: "PV" | "HE" | "BOTH"; routeSource?: string | null } = {}) => ({
  code: "SHL-01", scope: over.scope ?? "PV", routeSource: over.routeSource === undefined ? "Current shop practice" : over.routeSource,
});
const run = (p: ReturnType<typeof part>, v: VariantState[]) => evaluateReadiness(p, v, REF, HE);
const codes = (f: Array<{ code: string }>) => f.map((x) => x.code);

describe("evaluateReadiness — what blocks approval", () => {
  it("a complete DRAFT with a confirmed route source has no blockers", () => {
    expect(run(part(), [variant()]).blockers).toEqual([]);
  });

  const blocked: Array<[string, ReturnType<typeof part>, VariantState[], string]> = [
    ["route source still assumed", part({ routeSource: "Assumed – to be confirmed" }), [variant()], "ROUTE_SOURCE"],
    ["route source not recorded", part({ routeSource: null }), [variant()], "ROUTE_SOURCE"],
    ["a step with no department", part(), [variant({ steps: [step({ department: "" })] })], "MISSING_DEPARTMENT"],
    ["a department the tracker does not have", part(), [variant({ steps: [step({ department: "Mars" })] })], "UNKNOWN_DEPARTMENT"],
    ["a PV part with no PV stage", part(), [variant({ steps: [step({ pvStage: null })] })], "MISSING_STAGE"],
    ["a PV + HE part with no HE stage", part({ scope: "BOTH" }), [variant({ steps: [step({ heStage: null })] })], "MISSING_STAGE"],
    ["a PV stage the tracker does not have", part(), [variant({ steps: [step({ pvStage: 99 })] })], "UNKNOWN_STAGE_NUMBER"],
    ["an operation the tracker does not have", part(), [variant({ steps: [step({ operationCode: "LEVITATION" })] })], "UNKNOWN_OPERATION"],
    ["a variant with no steps", part(), [variant({ steps: [] })], "NO_STEPS"],
  ];
  it.each(blocked)("%s blocks approval", (_n, p, v, code) => {
    expect(codes(run(p, v).blockers)).toContain(code);
  });

  it("an HE-only part needs an HE stage, not a PV stage", () => {
    const ok = run(part({ scope: "HE" }), [variant({ steps: [step({ pvStage: null, heStage: 11 })] })]);
    expect(ok.blockers).toEqual([]);
    expect(codes(run(part({ scope: "HE" }), [variant({ steps: [step({ pvStage: 10, heStage: null })] })]).blockers)).toContain("MISSING_STAGE");
  });

  it("warnings never block: missing time, stage differing from the operation default, department mismatch", () => {
    const r = run(part(), [
      variant({
        steps: [
          step({ seq: 10, stdTime: null, stdTimeUnit: null, stdTimeBasis: null }),
          step({ seq: 20, operationCode: "FIT_UP", department: "Fabrication / Welding", pvStage: 25 }),
        ],
      }),
    ]);
    expect(r.blockers).toEqual([]);
    expect(codes(r.warnings)).toEqual(expect.arrayContaining(["MISSING_STD_TIME", "STAGE_DIFFERS_FROM_OPERATION_DEFAULT", "DEPARTMENT_STAGE_MISMATCH"]));
  });

  it("an already PUBLISHED variant is judged for warnings only", () => {
    const r = run(part({ routeSource: "Assumed – to be confirmed" }), [variant({ status: "PUBLISHED", steps: [step({ department: "" })] })]);
    expect(r.blockers).toEqual([]);
    expect(codes(r.warnings)).toContain("MISSING_DEPARTMENT");
  });

  it("a part with no routes (bought-out) has nothing to block", () => {
    expect(run(part({ routeSource: null }), []).blockers).toEqual([]);
  });

  it("findings carry the variant and step so the screen can point at them", () => {
    const r = run(part(), [variant({ variant: "B", steps: [step({ seq: 30, department: "" })] })]);
    expect(r.blockers[0]).toMatchObject({ variant: "B", seq: 30, code: "MISSING_DEPARTMENT" });
  });
});
