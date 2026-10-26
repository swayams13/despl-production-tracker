import { describe, expect, it } from "vitest";
import type { IntakeOptions } from "@/lib/services/job-intake.read";
import { emptyBlock } from "./wizard-state";
import { buildPickerEntries, filterPickerEntries, pickerSummary } from "./bom-picker-entries";

const type = (id: number, familyId: number, name: string, kit: Array<{ name: string; code: string }> = []) =>
  ({ id, familyId, code: name.toUpperCase().replace(/\s/g, "_"), name, kit: kit.map((k) => ({ ...k, qty: 1, qtySource: "FIXED" })) }) as IntakeOptions["equipmentTypes"][number];
const source = (equipmentId: number, over: Partial<IntakeOptions["bomSources"][number]> = {}) =>
  ({ equipmentId, label: `J-${equipmentId} — V`, itemCount: 12, equipmentName: "Air receiver", jobNumber: `J-${equipmentId}`, clientName: "Acme Gas", familyId: 1, equipmentTypeId: 1, equipmentTypeName: "Vertical vessel", partCodes: ["SHELL", "NOZZLE"], ...over }) as IntakeOptions["bomSources"][number];
const options = {
  equipmentTypes: [type(1, 1, "Vertical vessel", [{ name: "Shell", code: "SHELL" }, { name: "Dish end", code: "DISH" }]), type(2, 1, "Heat shield"), type(3, 2, "Exchanger", [{ name: "Tube", code: "TUBE" }])],
  bomSources: [source(10), source(11, { jobNumber: "DE0467", clientName: "Vedanta", partCodes: ["SKIRT"] }), source(12, { familyId: 2 })],
} as unknown as IntakeOptions;

describe("the master-BOM picker list", () => {
  it("is empty until a family is chosen", () => {
    expect(buildPickerEntries(options, null)).toEqual([]);
  });

  it("lists the family's types (kit first labelled, no-kit labelled) then its earlier lines, and never another family's", () => {
    const e = buildPickerEntries(options, 1);
    expect(e.map((x) => x.key)).toEqual(["kit:1", "type:2", "src:10", "src:11"]);
    expect(e[0].sub).toBe("Standard kit · 2 lines");
    expect(e[1].sub).toContain("no standard kit");
    expect(e[2].sub).toBe("J-10 · Acme Gas · 12 lines");
  });

  it.each([
    ["a name", "air", ["src:10", "src:11"]],
    ["a job number", "de0467", ["src:11"]],
    ["a client", "vedanta", ["src:11"]],
    ["an equipment type", "vertical", ["kit:1", "src:10", "src:11"]],
    ["a part code", "skirt", ["src:11"]],
    ["a kit part", "dish", ["kit:1"]],
    ["several words, all of which must match", "acme nozzle", ["src:10"]],
    ["nothing", "zzz", []],
  ])("filters by %s", (_n, q, keys) => {
    expect(filterPickerEntries(buildPickerEntries(options, 1), q).map((x) => x.key)).toEqual(keys);
  });

  it("shows everything for a blank query", () => {
    expect(filterPickerEntries(buildPickerEntries(options, 1), "  ")).toHaveLength(4);
  });
});

describe("what the closed picker says", () => {
  it.each([
    ["nothing chosen", {}, ""],
    ["a type only", { equipmentTypeId: 2 }, "Heat shield"],
    ["a kit", { equipmentTypeId: 1, bomMode: "KIT" }, "Vertical vessel · standard kit"],
    ["an upload", { equipmentTypeId: 1, bomMode: "UPLOAD" }, "Vertical vessel · uploaded BOM"],
    ["a copied line", { bomMode: "COPY", copyBomFromEquipmentId: 10 }, "Air receiver · J-10 · Acme Gas"],
    ["a copied line that is no longer listed", { bomMode: "COPY", copyBomFromEquipmentId: 99 }, "An earlier job's line (not in this list)"],
  ])("%s", (_n, over, text) => {
    expect(pickerSummary({ ...emptyBlock(), ...over } as never, options)).toBe(text);
  });
});
