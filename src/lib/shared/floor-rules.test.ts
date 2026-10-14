import { describe, expect, it } from "vitest";
import {
  type FloorItem,
  type OpItem,
  type PlanItem,
  type StepItem,
  type UnitFacts,
  checkReportedAt,
  checkStart,
  deriveRequiresQc,
  drawingStateOf,
  evaluateHard,
  evaluateSoft,
  h3DataGaps,
  workingHoursBetween,
} from "./floor-rules";
import { ERROR_CODES, ERROR_MESSAGES } from "./errors";
import { recordWorkSchema, sequenceOverrideSchema, inspectSchema } from "./schemas";

const step = (id: number, p: Partial<StepItem> = {}): StepItem => ({
  kind: "ASSEMBLY_STEP", id, seq: id, status: "NOT_STARTED", processSeq: null, openBlockingHold: false,
  stepKind: "WORK", role: null, jointRef: null, pressurePart: false, ...p,
});
const op = (id: number, p: Partial<OpItem> = {}): OpItem => ({
  kind: "COMPONENT_OP", id, componentId: 1, routeSeq: id, status: "NOT_STARTED", processSeq: null,
  openBlockingHold: false, opCode: "CUTTING", pressureRetaining: true, materialIssued: true, heatPicked: true,
  drawing: "RELEASED", ...p,
});
const plan = (id: number, processSeq: number, p: Partial<PlanItem> = {}): PlanItem => ({
  kind: "PROCESS_PLAN", id, status: "NOT_STARTED", processSeq, openBlockingHold: false, ...p,
});
const facts = (items: FloorItem[], p: Partial<UnitFacts> = {}): UnitFacts => ({
  items, excludedProcessSeqs: [], hasAssemblySequence: true, concessions: [], ...p,
});

// A unit shaped like DESPL-320: circ seam CS-1, a nozzle weld covering N1 and N2, final PWHT, hydro.
const fit = (s: StepItem["status"] = "NOT_STARTED", hold = false) =>
  step(14, { role: "FIT_UP", jointRef: "CS-1", pressurePart: true, status: s, openBlockingHold: hold });
const weld = (s: StepItem["status"] = "NOT_STARTED") => step(15, { role: "WELD", jointRef: "CS-1", pressurePart: true, status: s });
const ndt = (s: StepItem["status"] = "NOT_STARTED") => step(16, { role: "NDT", jointRef: "CS-1", pressurePart: true, status: s });
const nozzleWeld = (s: StepItem["status"] = "NOT_STARTED") => step(19, { role: "WELD", jointRef: "N1, N2", pressurePart: true, status: s });
const nozzleNdt = step(20, { role: "NDT", jointRef: "N2", pressurePart: true });
const pwht = (s: StepItem["status"] = "NOT_STARTED") => step(42, { role: "FINAL_PWHT", stepKind: "INSPECTION", status: s });
const hydro = (s: StepItem["status"] = "NOT_STARTED") => step(48, { role: "HYDRO", status: s });
const cleat = step(30, { role: "WELD", pressurePart: false });
const lug = step(31, { role: "WELD", pressurePart: true });

describe("HARD rules — violations first, then pass and not-applicable", () => {
  const cases: Array<[string, FloorItem, UnitFacts, string | null]> = [
    // H1
    ["H1 weld before its fit-up", weld(), facts([fit(), weld()]), "JOINT_SEQUENCE_BLOCKED"],
    ["H1 NDT before its weld", ndt(), facts([fit("COMPLETE"), weld("IN_PROGRESS"), ndt()]), "JOINT_SEQUENCE_BLOCKED"],
    ["H1 multi-joint nozzle NDT waits on the weld that covers N2", nozzleNdt, facts([nozzleWeld(), nozzleNdt]), "JOINT_SEQUENCE_BLOCKED"],
    ["H1 passes once fit-up is SUBMITTED (H1 default)", weld(), facts([fit("SUBMITTED"), weld()]), null],
    ["H1 n/a: weld with no jointRef", step(15, { role: "WELD" }), facts([fit(), step(15, { role: "WELD" })]), null],
    ["H1 n/a: no role data", step(15, { jointRef: "CS-1" }), facts([fit(), step(15, { jointRef: "CS-1" })]), null],
    ["H1 n/a: other joint", weld(), facts([step(9, { role: "FIT_UP", jointRef: "CS-2" }), weld()]), null],
    // HOLD_LINK (D12)
    ["HOLD_LINK open H point on the fit-up blocks its weld", weld(), facts([fit("SUBMITTED", true), weld()]), "HOLD_POINT_OPEN"],
    ["HOLD_LINK open H point on an earlier op of the same part", op(2, { opCode: "ROLLING" }),
      facts([op(1, { status: "SUBMITTED", openBlockingHold: true }), op(2, { opCode: "ROLLING" })]), "HOLD_POINT_OPEN"],
    ["HOLD_LINK does not block an unrelated joint", nozzleWeld(), facts([fit("SUBMITTED", true), nozzleWeld()]), null],
    ["HOLD_LINK does not block another part", op(2, { componentId: 2 }),
      facts([op(1, { status: "SUBMITTED", openBlockingHold: true }), op(2, { componentId: 2 })]), null],
    // H2
    ["H2 pressure cutting, material not issued", op(1, { materialIssued: false }), facts([]), "MATERIAL_NOT_ISSUED"],
    ["H2 pressure cutting, heat number not picked", op(1, { heatPicked: false }), facts([]), "HEAT_NUMBER_NOT_PICKED"],
    ["H2 passes when issued and picked", op(1), facts([]), null],
    ["H2 n/a: non-pressure part", op(1, { pressureRetaining: false, materialIssued: false, heatPicked: false }), facts([]), null],
    ["H2 n/a: not a cutting op", op(1, { opCode: "ROLLING", materialIssued: false }), facts([]), null],
    // H3
    ["H3 pressure cutting, drawing not released", op(1, { drawing: "NOT_RELEASED" }), facts([]), "DRAWING_NOT_RELEASED"],
    ["H3 passes on an at-risk release", op(1, { drawing: "AT_RISK" }), facts([]), null],
    ["H3 no-op with no drawing link (data gap)", op(1, { drawing: "NO_LINK" }), facts([]), null],
    ["H3 n/a: non-pressure part", op(1, { pressureRetaining: false, drawing: "NOT_RELEASED" }), facts([]), null],
    // H4
    ["H4 hydro before final PWHT complete", hydro(), facts([pwht("SUBMITTED"), hydro()]), "PWHT_NOT_COMPLETE"],
    ["H4 passes once PWHT COMPLETE", hydro(), facts([pwht("COMPLETE"), hydro()]), null],
    ["H4 n/a: PWHT process excluded", hydro(), facts([pwht(), hydro()], { excludedProcessSeqs: [21] }), null],
    ["H4 n/a: unit has no PWHT step", hydro(), facts([hydro()]), null],
    // H5
    ["H5 pressure weld after final PWHT started", nozzleWeld(), facts([pwht("IN_PROGRESS"), nozzleWeld()]), "WELD_AFTER_PWHT"],
    ["H5 lug on a pressure part counts", lug, facts([pwht("SUBMITTED"), lug]), "WELD_AFTER_PWHT"],
    ["H5 pressure fit-up op after PWHT", op(5, { opCode: "FIT_UP" }), facts([pwht("COMPLETE"), op(5, { opCode: "FIT_UP" })]), "WELD_AFTER_PWHT"],
    ["H5 concession on another target does not exempt", nozzleWeld(),
      facts([pwht("COMPLETE"), nozzleWeld()], { concessions: [{ rule: "H5", kind: "ASSEMBLY_STEP", id: 31 }] }), "WELD_AFTER_PWHT"],
    ["H5 concession of the wrong rule does not exempt", nozzleWeld(),
      facts([pwht("COMPLETE"), nozzleWeld()], { concessions: [{ rule: "H6", kind: "ASSEMBLY_STEP", id: 19 }] }), "WELD_AFTER_PWHT"],
    ["H5 concession exempts its own target", nozzleWeld(),
      facts([pwht("COMPLETE"), nozzleWeld()], { concessions: [{ rule: "H5", kind: "ASSEMBLY_STEP", id: 19 }] }), null],
    ["H5 passes before PWHT starts", nozzleWeld(), facts([pwht(), nozzleWeld()]), null],
    ["H5 n/a: non-pressure weld", cleat, facts([pwht("COMPLETE"), cleat]), null],
    ["H5 n/a: PFHT (HEAT_TREATMENT) does not trigger", nozzleWeld(),
      facts([step(41, { role: "HEAT_TREATMENT", status: "COMPLETE" }), nozzleWeld()]), null],
    ["H5 n/a: PWHT process excluded", nozzleWeld(), facts([pwht("COMPLETE"), nozzleWeld()], { excludedProcessSeqs: [21] }), null],
    // H6
    ["H6 hydro with a pressure weld incomplete", hydro(), facts([weld("SUBMITTED"), hydro()]), "HYDRO_PREREQUISITES_INCOMPLETE"],
    ["H6 hydro with a pressure NDT op incomplete", hydro(), facts([op(7, { opCode: "NDT" }), hydro()]), "HYDRO_PREREQUISITES_INCOMPLETE"],
    ["H6 pressure weld after hydro started", nozzleWeld(), facts([hydro("IN_PROGRESS"), nozzleWeld()]), "WELD_AFTER_HYDRO"],
    ["H6 concession exempts its own target", nozzleWeld(),
      facts([hydro("COMPLETE"), nozzleWeld()], { concessions: [{ rule: "H6", kind: "ASSEMBLY_STEP", id: 19 }] }), null],
    ["H6 hydro passes when every pressure weld/NDT is COMPLETE", hydro(),
      facts([weld("COMPLETE"), ndt("COMPLETE"), cleat, hydro()]), null],
    ["H6 n/a: non-pressure weld after hydro", cleat, facts([hydro("COMPLETE"), cleat]), null],
    // PAINT_AFTER_HYDRO (invariant 2)
    ["PAINT surface prep before hydro complete", plan(1, 29), facts([plan(2, 27, { status: "SUBMITTED" })]), "PAINT_BEFORE_HYDRO"],
    ["PAINT painting op before hydro complete", op(9, { opCode: "PAINTING", processSeq: 30 }), facts([hydro("SUBMITTED")]), "PAINT_BEFORE_HYDRO"],
    ["PAINT passes once hydro step COMPLETE", plan(1, 30), facts([hydro("COMPLETE")]), null],
    ["PAINT passes once process 27 COMPLETE", plan(1, 29), facts([plan(2, 27, { status: "COMPLETE" })]), null],
    ["PAINT n/a: other process", plan(1, 28), facts([]), null],
  ];

  it.each(cases)("%s", (_name, item, f, code) => {
    expect(evaluateHard(item, f)?.code ?? null).toBe(code);
  });

  it("H5/H6 refusals carry routeTo NCR", () => {
    expect(evaluateHard(nozzleWeld(), facts([pwht("IN_PROGRESS")]))?.meta).toMatchObject({ rule: "H5", routeTo: "NCR" });
    expect(evaluateHard(nozzleWeld(), facts([hydro("IN_PROGRESS")]))?.meta).toMatchObject({ rule: "H6", routeTo: "NCR" });
  });

  it("H3 data gaps list pressure cutting ops with no drawing link only", () => {
    const f = facts([op(1, { drawing: "NO_LINK" }), op(2, { drawing: "NO_LINK", pressureRetaining: false }), op(3)]);
    expect(h3DataGaps(f).map((o) => o.id)).toEqual([1]);
  });
});

describe("SOFT (D2) and override authority", () => {
  const nozzleFit = step(18, { role: "FIT_UP", jointRef: "N1", pressurePart: true });
  const sup = { roles: ["SUPERVISOR"], hasOverride: true };

  const cases: Array<[string, FloorItem, UnitFacts, { roles: string[]; hasOverride: boolean }, string | null]> = [
    ["open earlier WORK step, no override", nozzleFit, facts([fit("IN_PROGRESS"), nozzleFit]), { roles: ["SUPERVISOR"], hasOverride: false }, "SEQUENCE_OVERRIDE_REQUIRED"],
    ["OPERATOR with an override still refused", nozzleFit, facts([fit("IN_PROGRESS"), nozzleFit]), { roles: ["OPERATOR"], hasOverride: true }, "SEQUENCE_OVERRIDE_REQUIRED"],
    ["ADMIN alone cannot override", nozzleFit, facts([fit("IN_PROGRESS"), nozzleFit]), { roles: ["ADMIN"], hasOverride: true }, "SEQUENCE_OVERRIDE_REQUIRED"],
    ["PLANNER cannot override a floor step", nozzleFit, facts([fit("IN_PROGRESS"), nozzleFit]), { roles: ["PLANNER"], hasOverride: true }, "SEQUENCE_OVERRIDE_REQUIRED"],
    ["component route order is SOFT", op(2, { opCode: "ROLLING" }), facts([op(1, { status: "IN_PROGRESS" }), op(2)]), { roles: ["OPERATOR"], hasOverride: false }, "SEQUENCE_OVERRIDE_REQUIRED"],
    ["processes 1–11 are SOFT", plan(5, 5), facts([plan(4, 4), plan(5, 5)]), { roles: ["OPERATOR"], hasOverride: false }, "SEQUENCE_OVERRIDE_REQUIRED"],
    ["HARD wins over an override", weld(), facts([fit(), weld()]), sup, "JOINT_SEQUENCE_BLOCKED"],
    ["SUPERVISOR override passes", nozzleFit, facts([fit("IN_PROGRESS"), nozzleFit]), sup, null],
    ["PRODUCTION_HEAD override passes", nozzleFit, facts([fit("IN_PROGRESS"), nozzleFit]), { roles: ["PRODUCTION_HEAD"], hasOverride: true }, null],
    ["PLANNER override passes on processes 1–11", plan(5, 5), facts([plan(4, 4), plan(5, 5)]), { roles: ["PLANNER"], hasOverride: true }, null],
    ["earlier INSPECTION steps are excluded", nozzleFit, facts([step(17, { stepKind: "INSPECTION" }), nozzleFit]), { roles: [], hasOverride: false }, null],
    ["earlier done (SUBMITTED) step is not open", nozzleFit, facts([fit("SUBMITTED"), nozzleFit]), { roles: [], hasOverride: false }, null],
    ["no assembly sequence → no SOFT gating", nozzleFit, facts([fit("IN_PROGRESS"), nozzleFit], { hasAssemblySequence: false }), { roles: [], hasOverride: false }, null],
    ["no assembly sequence → HARD still refuses (H2)", op(2, { heatPicked: false }), facts([op(1), op(2)], { hasAssemblySequence: false }), { roles: [], hasOverride: false }, "HEAT_NUMBER_NOT_PICKED"],
    ["office process 12+ has no SOFT order", plan(12, 12), facts([plan(4, 4), plan(12, 12)]), { roles: [], hasOverride: false }, null],
  ];

  it.each(cases)("%s", (_name, item, f, actor, code) => {
    const r = checkStart(item, f, actor);
    expect(r.ok ? null : r.code).toBe(code);
  });

  it("canOverride meta tells the operator to ask a supervisor", () => {
    const r = checkStart(nozzleFit, facts([fit("IN_PROGRESS"), nozzleFit]), { roles: ["OPERATOR"], hasOverride: false });
    expect(r).toMatchObject({ ok: false, meta: { canOverride: false } });
    const s = checkStart(nozzleFit, facts([fit("IN_PROGRESS"), nozzleFit]), { roles: ["SUPERVISOR"], hasOverride: false });
    expect(s).toMatchObject({ ok: false, meta: { canOverride: true } });
  });

  it("an earlier step linked by a HARD rule is not double-counted as SOFT", () => {
    // NDT on CS-1: the open fit-up and weld are H1-linked (HARD); the unrelated open step 10 is the only SOFT one.
    const other = step(10, { status: "IN_PROGRESS" });
    const open = evaluateSoft(ndt(), facts([other, fit("IN_PROGRESS"), weld("IN_PROGRESS"), ndt()]));
    expect(open.map((i) => i.id)).toEqual([10]);
  });

  it("overridden predecessors are returned for the SequenceOverride rows", () => {
    const r = checkStart(nozzleFit, facts([step(10), fit("IN_PROGRESS"), nozzleFit]), sup);
    expect(r.ok && r.overridden.map((i) => i.id)).toEqual([10, 14]);
  });
});

describe("reportedAt window (D4)", () => {
  // Sat 17 Oct 2026 10:00 IST; the 72 h before it holds no Sunday.
  const now = new Date("2026-10-17T04:30:00Z");
  const base = { now, action: "START" as const, releaseDate: null, orderDate: null };
  const at = (iso: string) => new Date(iso);
  const s = 1000;

  const cases: Array<[string, Parameters<typeof checkReportedAt>[0], string | null]> = [
    ["future by 1 s", { ...base, reportedAt: new Date(now.getTime() + s) }, "FUTURE"],
    ["72 h + 1 s back", { ...base, reportedAt: new Date(now.getTime() - 72 * 3600 * s - s) }, "TOO_OLD"],
    ["before the release date", { ...base, reportedAt: at("2026-10-15T04:30:00Z"), releaseDate: at("2026-10-16T06:00:00Z") }, "BEFORE_RELEASE"],
    ["no release date → order date is the floor", { ...base, reportedAt: at("2026-10-15T04:30:00Z"), orderDate: at("2026-10-16T00:00:00Z") }, "BEFORE_RELEASE"],
    ["DONE before START", { ...base, action: "DONE", reportedAt: at("2026-10-16T04:30:00Z"), startedAt: at("2026-10-16T04:30:01Z") }, "DONE_BEFORE_START"],
    ["Sunday window: 72 working hours + 1 s", { ...base, now: at("2026-10-19T04:30:00Z"), reportedAt: at("2026-10-15T04:29:59Z") }, "TOO_OLD"],
    ["exactly now", { ...base, reportedAt: now }, null],
    ["72 h − 1 s back", { ...base, reportedAt: new Date(now.getTime() - 72 * 3600 * s + s) }, null],
    ["exactly 72 h back", { ...base, reportedAt: new Date(now.getTime() - 72 * 3600 * s) }, null],
    ["same IST day as release, before release time (day grain)", { ...base, reportedAt: at("2026-10-16T03:00:00Z"), releaseDate: at("2026-10-16T06:00:00Z") }, null],
    ["release date wins over the order date", { ...base, reportedAt: at("2026-10-15T04:30:00Z"), releaseDate: at("2026-10-15T01:00:00Z"), orderDate: at("2026-10-16T00:00:00Z") }, null],
    ["no release or order date → window only", { ...base, reportedAt: at("2026-10-15T04:30:00Z") }, null],
    ["DONE equal to START", { ...base, action: "DONE", reportedAt: at("2026-10-16T04:30:00Z"), startedAt: at("2026-10-16T04:30:00Z") }, null],
    ["START ignores startedAt", { ...base, reportedAt: at("2026-10-16T04:30:00Z"), startedAt: at("2026-10-16T05:00:00Z") }, null],
    // Mon 19 Oct 10:00 IST back to Thu 15 Oct 10:00 IST = 96 calendar hours, 72 working hours (Sunday off).
    ["Sunday window: exactly 72 working hours", { ...base, now: at("2026-10-19T04:30:00Z"), reportedAt: at("2026-10-15T04:30:00Z") }, null],
  ];

  it.each(cases)("%s", (_name, input, reason) => {
    expect(checkReportedAt(input)).toBe(reason);
  });

  // Review fix (14 Oct): reportedAt is client input; the walk is bounded.
  it("a year-0001 reportedAt with no release or order date is TOO_OLD, fast", () => {
    const t0 = performance.now();
    expect(checkReportedAt({ ...base, reportedAt: at("0001-01-01T00:00:00Z") })).toBe("TOO_OLD");
    // 100 ms does not discriminate: the unbounded walk took ~70 ms here. Bounded, it is microseconds.
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it("a calendar with no working day still refuses a reportedAt years back (iteration cap)", () => {
    const never = { weekOffDays: [0, 1, 2, 3, 4, 5, 6, 7] };
    expect(checkReportedAt({ ...base, reportedAt: at("2024-10-17T04:30:00Z"), calendar: never })).toBe("TOO_OLD");
  });

  it("counts Sunday by the IST day, not the UTC day", () => {
    // Sat 23:00 IST → Sun 01:00 IST: only the Saturday hour counts.
    expect(workingHoursBetween(at("2026-10-17T17:30:00Z"), at("2026-10-17T19:30:00Z"))).toBe(1);
    // A holiday on the calendar counts as zero too.
    expect(workingHoursBetween(at("2026-10-15T18:30:00Z"), at("2026-10-16T18:30:00Z"), { weekOffDays: [7], holidays: [at("2026-10-16T00:00:00Z")] })).toBe(0);
  });
});

describe("deriveRequiresQc (D3) — one row per category", () => {
  const cases: Array<[string, Parameters<typeof deriveRequiresQc>[0], boolean]> = [
    ["QC inspection step", { kind: "ASSEMBLY_STEP", stepKind: "INSPECTION", qcpLinked: true, pressure: true }, false],
    ["office process 1–11, even if QCP-linked", { kind: "PROCESS_PLAN", processSeq: 3, qcpLinked: true, pressure: false }, false],
    ["handling", { kind: "COMPONENT_OP", opCode: "RECEIPT", qcpLinked: false, pressure: true }, false],
    ["non-pressure cutting and marking", { kind: "COMPONENT_OP", opCode: "CUTTING", qcpLinked: false, pressure: false }, false],
    ["rolling", { kind: "COMPONENT_OP", opCode: "ROLLING", qcpLinked: false, pressure: true }, false],
    ["edge prep", { kind: "COMPONENT_OP", opCode: "EDGE_PREP", qcpLinked: false, pressure: true }, false],
    ["non-pressure attachment weld", { kind: "ASSEMBLY_STEP", stepKind: "WORK", role: "WELD", qcpLinked: false, pressure: false }, false],
    ["linked to a QCP point", { kind: "ASSEMBLY_STEP", stepKind: "WORK", qcpLinked: true, pressure: false }, true],
    ["fit-up on a pressure joint", { kind: "ASSEMBLY_STEP", stepKind: "WORK", role: "FIT_UP", qcpLinked: false, pressure: true }, true],
    ["welding op on a pressure part", { kind: "COMPONENT_OP", opCode: "WELDING", qcpLinked: false, pressure: true }, true],
    ["heat-number transfer at pressure cutting", { kind: "COMPONENT_OP", opCode: "CUTTING", qcpLinked: false, pressure: true }, true],
    ["PWHT record", { kind: "ASSEMBLY_STEP", stepKind: "WORK", role: "FINAL_PWHT", qcpLinked: false, pressure: false }, true],
    ["PFHT record", { kind: "ASSEMBLY_STEP", stepKind: "WORK", role: "HEAT_TREATMENT", qcpLinked: false, pressure: false }, true],
    ["hydro", { kind: "ASSEMBLY_STEP", stepKind: "WORK", role: "HYDRO", qcpLinked: false, pressure: false }, true],
    ["painting DFT", { kind: "COMPONENT_OP", opCode: "PAINTING", qcpLinked: false, pressure: false }, true],
    ["final dimensional / name-plate stamping", { kind: "ASSEMBLY_STEP", stepKind: "WORK", testRecord: true, qcpLinked: false, pressure: false }, true],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(deriveRequiresQc(input).requiresQc).toBe(expected);
  });
});

describe("drawingStateOf: H3 state from the current revision (L1.2c)", () => {
  const at = new Date("2026-10-14T05:00:00Z");
  it.each<[string, Parameters<typeof drawingStateOf>[0], boolean, string]>([
    ["no governing drawing link", null, false, "NO_LINK"],
    ["linked, no revision issued", null, true, "NOT_RELEASED"],
    ["current DRAFT, not at risk", { status: "DRAFT", atRiskReleasedAt: null }, true, "NOT_RELEASED"],
    ["current SUBMITTED, not at risk", { status: "SUBMITTED", atRiskReleasedAt: null }, true, "NOT_RELEASED"],
    ["current DRAFT released at risk", { status: "DRAFT", atRiskReleasedAt: at }, true, "AT_RISK"],
    ["current APPROVED released at risk", { status: "APPROVED", atRiskReleasedAt: at }, true, "AT_RISK"],
    ["current RELEASED", { status: "RELEASED", atRiskReleasedAt: null }, true, "RELEASED"],
    ["RELEASED wins over a stale at-risk release", { status: "RELEASED", atRiskReleasedAt: at }, true, "RELEASED"],
  ])("%s -> %s", (_name, current, linked, expected) => {
    expect(drawingStateOf(current, linked)).toBe(expected);
  });

  it("an AT_RISK drawing passes H3 for pressure-part cutting; NOT_RELEASED still refuses", () => {
    const cut = (drawing: OpItem["drawing"]) => op(1, { drawing });
    expect(evaluateHard(cut("AT_RISK"), facts([cut("AT_RISK")]))).toBeNull();
    expect(evaluateHard(cut("NOT_RELEASED"), facts([cut("NOT_RELEASED")]))?.code).toBe("DRAWING_NOT_RELEASED");
  });
});

describe("schemas and error codes", () => {
  it("override chip OTHER needs a note; others do not", () => {
    expect(sequenceOverrideSchema.safeParse({ category: "OTHER" }).success).toBe(false);
    expect(sequenceOverrideSchema.safeParse({ category: "OTHER", note: "  " }).success).toBe(false);
    expect(sequenceOverrideSchema.safeParse({ category: "OTHER", note: "crane booked" }).success).toBe(true);
    expect(sequenceOverrideSchema.safeParse({ category: "CLIENT_PRIORITY" }).success).toBe(true);
    expect(sequenceOverrideSchema.safeParse({ category: "WHATEVER" }).success).toBe(false);
  });

  const item = { kind: "ASSEMBLY_STEP", id: 1 };
  const ok = { jobId: 1, action: "START", items: [item] };
  it.each<[string, unknown, boolean]>([
    ["no items", { ...ok, items: [] }, false],
    ["101 items", { ...ok, items: Array.from({ length: 101 }, (_, i) => ({ kind: "COMPONENT_OP", id: i + 1 })) }, false],
    ["duplicate item", { ...ok, items: [item, item] }, false],
    ["a client actual_* field", { ...ok, actualStart: "2026-10-14T00:00:00Z" }, false],
    ["reportedAt not ISO", { ...ok, reportedAt: "yesterday" }, false],
    ["requestId not a uuid", { ...ok, requestId: "abc" }, false],
    ["same id, different kinds", { ...ok, items: [item, { kind: "COMPONENT_OP", id: 1 }] }, true],
    ["full payload", { ...ok, action: "DONE", requestId: "6f1c7b8e-2a4d-4f3b-9c1e-5d7a8b9c0d1e", reportedAt: "2026-10-14T10:00:00+05:30",
      override: { category: "MATERIAL_READY_EARLY" }, lateReason: { categoryId: 2 } }, true],
  ])("recordWorkSchema: %s", (_name, input, valid) => {
    expect(recordWorkSchema.safeParse(input).success).toBe(valid);
  });

  it("inspect REJECT needs a reason", () => {
    expect(inspectSchema.safeParse({ kind: "ASSEMBLY_STEP", targetId: 1, result: "REJECT" }).success).toBe(false);
    expect(inspectSchema.safeParse({ kind: "ASSEMBLY_STEP", targetId: 1, result: "REJECT", reason: "undercut" }).success).toBe(true);
    expect(inspectSchema.safeParse({ kind: "ASSEMBLY_STEP", targetId: 1, result: "ACCEPT" }).success).toBe(true);
  });

  it.each([
    "DERIVED_STATUS", "SEQUENCE_OVERRIDE_REQUIRED", "REPORTED_AT_OUT_OF_WINDOW", "LATE_REASON_REQUIRED", "INSPECT_REQUIRED", "INSPECT_PRECONDITION",
    "JOINT_SEQUENCE_BLOCKED", "MATERIAL_NOT_ISSUED", "HEAT_NUMBER_NOT_PICKED", "PWHT_NOT_COMPLETE",
    "HYDRO_PREREQUISITES_INCOMPLETE", "WELD_AFTER_PWHT", "WELD_AFTER_HYDRO", "PAINT_BEFORE_HYDRO",
  ] as const)("%s has a code and a plain-English message", (code) => {
    expect(ERROR_CODES[code]).toBe(code);
    expect(ERROR_MESSAGES[code].length).toBeGreaterThan(20);
  });
});
