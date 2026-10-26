import { describe, expect, it } from "vitest";
import { createJobSchema } from "@/lib/shared/schemas";
import type { IntakeOptions, IntakeFamily } from "@/lib/services/job-intake.read";
import {
  allValid, bomSourceLabel, defaultState, emptyBlock, fromPayload, payloadToInput, resumeStep, step2BlockReason, step3BlockReason, stepBlockReason, toPayload, type EquipBlockState, type WizardState,
} from "./wizard-state";

const families = [
  { id: 1, code: "PRESSURE_VESSEL", name: "PV", schedulable: true, versions: [{ id: 10, templateName: "PV", version: 1, processCount: 36, provisionalCount: 0, notes: null }] },
  { id: 2, code: "X", name: "No route", schedulable: false, versions: [] },
] as IntakeFamily[];
const options = { calendars: [{ id: 5, name: "6-day", isDefault: true }], families } as unknown as IntakeOptions;

const line = (over = {}) => ({ ...emptyBlock(), name: "Vessel", serials: ["S1", "S2"], ...over });
const good = (over: Partial<WizardState> = {}): WizardState => ({
  ...defaultState(options),
  clientId: 3, jobNumber: "J-1", committedDeliveryDate: "2027-03-31", familyId: 1, versionId: 10, equipments: [line()], ...over,
});

describe("step 2 (family, route, lines) says why it cannot go on", () => {
  it.each([
    ["no family", { familyId: null }, "Choose the product family"],
    ["a family with no route", { familyId: 2 }, "no published process route"],
    ["no route version", { versionId: null }, "Choose the process route version"],
    ["no lines", { equipments: [] }, "at least one equipment line"],
    ["a nameless line", { equipments: [line({ name: " " })] }, "Give line 1 a name"],
    ["a kit fill with no type", { equipments: [line({ bomMode: "KIT" })] }, "Choose the equipment type of Vessel"],
    ["a copy with no source", { equipments: [line({ bomMode: "COPY" })] }, "Choose the job whose BOM"],
    ["a line with no serials", { equipments: [line({ serials: [""] })] }, "at least one serial"],
    ["duplicate serials", { equipments: [line({ serials: ["S1", "S1"] })] }, "must be unique"],
    ["a lot with no quantity", { equipments: [line({ tracking: "LOT", lotQty: "0" })] }, "pieces are in the lot"],
  ])("%s", (_n, patch, text) => {
    const r = step2BlockReason(good(patch as Partial<WizardState>), families);
    expect(r).toContain(text);
    expect(allValid(good(patch as Partial<WizardState>), families)).toBe(false);
  });

  it("a serial line, a lot, and a kit fill with a type all pass", () => {
    expect(step2BlockReason(good(), families)).toBeNull();
    expect(step2BlockReason(good({ equipments: [line({ tracking: "LOT", lotQty: "40", serials: [] })] }), families)).toBeNull();
    expect(step2BlockReason(good({ equipments: [line({ bomMode: "KIT", equipmentTypeId: 7 })] }), families)).toBeNull();
  });
});

describe("step 3 (configure)", () => {
  it("leaving processes out needs a reason; with one it passes", () => {
    expect(step3BlockReason(good({ excludedProcessCodes: ["20", "21"] }))).toBe("Say why 2 processes are left out");
    expect(step3BlockReason(good({ excludedProcessCodes: ["20"] }))).toBe("Say why 1 process is left out");
    expect(step3BlockReason(good({ excludedProcessCodes: ["20"], exclusionReason: "client skips it" }))).toBeNull();
    expect(step3BlockReason(good())).toBeNull();
  });
  it("steps 4 and 5 never block", () => {
    expect(stepBlockReason(4, good(), families)).toBeNull();
    expect(stepBlockReason(5, defaultState(options), families)).toBeNull();
  });
});

describe("the draft payload", () => {
  const s = good({
    clientOrderNo: "PO-9", designCode: "ASME VIII", answers: { shell_courses: "2", pwht: "true" }, excludedProcessCodes: ["20"], exclusionReason: "no",
    qcpTemplateSourceId: 4, equipments: [line({ bomMode: "KIT", equipmentTypeId: 7, copyWeldMapFromEquipmentId: 99 }), line({ name: "Lot", tracking: "LOT", lotQty: "40", serials: [], bomMode: "COPY", copyBomFromEquipmentId: 55 })],
  });

  it("round trips through fromPayload without losing a field the wizard shows", () => {
    const back = fromPayload(JSON.parse(JSON.stringify(toPayload(s))), options);
    expect(toPayload(back)).toEqual(toPayload(s));
    expect(back.equipments.map((e) => [e.bomMode, e.tracking, e.copyBomFromEquipmentId, e.copyWeldMapFromEquipmentId])).toEqual([["KIT", "SERIAL", null, 99], ["COPY", "LOT", 55, null]]);
  });

  it("is accepted whole by createJobSchema once the wizard is valid", () => {
    const input = payloadToInput(toPayload(s));
    expect(() => createJobSchema.parse(input)).not.toThrow();
    expect(input.committedDeliveryDate).toBeInstanceOf(Date);
  });

  it("carries no actual_* or *_at key at any level (invariant 1)", () => {
    const keys = JSON.stringify(toPayload(s)).match(/"([A-Za-z_]+)":/g)!.map((k) => k.slice(1, -2));
    expect(keys.filter((k) => /^actual|_at$|At$/.test(k))).toEqual([]);
  });

  it("a half-made draft restores and resumes at the first step that is not valid", () => {
    expect(resumeStep(fromPayload({ jobNumber: "J-2", equipments: [{ name: "Vessel" }] }, options), families)).toBe(1);
    const half = fromPayload(toPayload(good({ equipments: [line({ serials: [] })] })), options);
    expect(resumeStep(half, families)).toBe(2);
    expect(resumeStep(fromPayload(toPayload(good()), options), families)).toBe(5);
  });

  it("a copy-a-job draft (no job number or dates, per-line sources) opens on the order step", () => {
    const copy = fromPayload(
      { clientId: 3, familyId: 1, templateVersionId: 10, calendarId: 5, priority: "HIGH", equipments: [{ equipmentTypeId: 7, name: "Shell", serials: [], config: { shell_courses: 2 }, copyBomFromEquipmentId: 55, copyWeldMapFromEquipmentId: 55 }] },
      options,
    );
    expect(copy).toMatchObject({ jobNumber: "", priority: "HIGH", answers: { shell_courses: "2" } });
    expect(copy.equipments[0]).toMatchObject({ bomMode: "COPY", copyBomFromEquipmentId: 55, copyWeldMapFromEquipmentId: 55, serials: [""] });
    expect(resumeStep(copy, families)).toBe(1);
  });

  it("the Build from master route starts new lines with the kit fill on", () => {
    expect(defaultState(options, "master").equipments[0].bomMode).toBe("KIT");
    expect(defaultState(options, "template").equipments[0].bomMode).toBe("NONE");
  });
});

describe("the review step's BOM label follows the real source", () => {
  const opts = {
    bomSources: [{ equipmentId: 7, label: "J-0 Vessel", itemCount: 12 }],
    equipmentTypes: [{ id: 1, name: "Air receiver", kit: [{ name: "Shell", qty: 1 }] }, { id: 2, name: "Empty type", kit: [] }],
  } as unknown as Parameters<typeof bomSourceLabel>[1];
  it.each<[string, Partial<EquipBlockState>, string]>([
    ["no BOM chosen", { bomMode: "NONE" }, "Not started"],
    ["copy, nothing picked", { bomMode: "COPY" }, "Copy chosen, but no previous line picked"],
    ["copy from a source with lines", { bomMode: "COPY", copyBomFromEquipmentId: 7 }, "Copied from J-0 Vessel (12 lines)"],
    ["copy from a line that has no BOM lines", { bomMode: "COPY", copyBomFromEquipmentId: 99 }, "Nothing to copy: the chosen line has no BOM lines"],
    ["kit, no type", { bomMode: "KIT" }, "Standard kit chosen, but no equipment type picked"],
    ["kit with lines", { bomMode: "KIT", equipmentTypeId: 1 }, "From the Air receiver kit (1 line)"],
    ["kit that is empty", { bomMode: "KIT", equipmentTypeId: 2 }, "The Empty type kit is empty: no BOM lines"],
  ])("%s", (_n, over, label) => {
    expect(bomSourceLabel(line(over), opts)).toBe(label);
  });
});
