import { describe, expect, it } from "vitest";
import { buildReleaseWarnings, suggestPartFamily, type PartFamilyOption } from "./bom-release.rules";

const opts: PartFamilyOption[] = [
  { componentTypeId: 1, code: "SHL-01", name: "Shell course" },
  { componentTypeId: 2, code: "HD-01", name: "Dished head" },
  { componentTypeId: 3, code: "PLATE", name: "Plate" },
  { componentTypeId: 4, code: "NOZ-FLG", name: "Nozzle flange" },
  { componentTypeId: 5, code: "NOZ-NECK", name: "Nozzle neck" },
];

describe("suggestPartFamily", () => {
  it.each([
    ["Shell course 1", 1],
    ["shell  COURSE", 1],
    ["Top dished head", 2],
    ["Plate 12mm", 3],
    ["Nozzle flange N1", 4],
  ])("%s -> family %i", (name, id) => {
    expect(suggestPartFamily(name, opts)?.componentTypeId).toBe(id);
  });

  it.each([["Totally unknown bracket"], [""], ["   "], ["Nozzle"]])("suggests nothing for %j (no match, or a tie)", (name) => {
    expect(suggestPartFamily(name, opts)).toBeNull();
  });

  it("uses an alias word to break a tie between families", () => {
    const o = [{ componentTypeId: 9, code: "PLATE", name: "Flat stock" }, { componentTypeId: 8, code: "PIPE", name: "Flat stock" }];
    expect(suggestPartFamily("Flat stock plate", o)).toBeNull();
    expect(suggestPartFamily("Flat stock plate", o, { plate: "PLATE" })?.componentTypeId).toBe(9);
  });

  it("says why", () => {
    expect(suggestPartFamily("Shell course", opts)?.reason).toBe("Same name");
  });
});

describe("buildReleaseWarnings", () => {
  const none = { unmappedItemNos: [], noRouteItemNos: [], unmappedKitCodes: [], hasQcp: true, unconfirmedJoints: 0, emptyJointTypes: [], pressureParts: 0 };

  it("is empty for a clean release", () => {
    expect(buildReleaseWarnings(none)).toEqual([]);
  });

  // L1.2h: a sequence whose steps carry no role silently switches H1 and H4-H6 off for the units it makes.
  it("warns first, and only, when the assembly sequence carries no step roles", () => {
    const w = buildReleaseWarnings({ ...none, stepsWithoutRoles: true, hasQcp: false });
    expect(w.map((x) => x.code)).toEqual(["STEP_ROLES_MISSING", "NO_QCP"]);
    expect(w[0].message).toMatch(/no step roles/);
    expect(w[0].message).toMatch(/H1/);
    expect(w[0].items).toEqual([]);
  });

  it.each([[false], [undefined]])("is silent about roles when stepsWithoutRoles is %s", (stepsWithoutRoles) => {
    expect(buildReleaseWarnings({ ...none, stepsWithoutRoles })).toEqual([]);
  });

  it("lists every kind, in screen order, with the items concerned", () => {
    const w = buildReleaseWarnings({
      unmappedItemNos: [3, 7],
      noRouteItemNos: [9],
      unmappedKitCodes: ["PLT"],
      hasQcp: false,
      unconfirmedJoints: 1,
      emptyJointTypes: ["nozzle"],
      pressureParts: 4,
    });
    expect(w.map((x) => x.code)).toEqual(["LINES_UNMAPPED", "LINES_NO_ROUTE", "KIT_COMPONENT_UNMAPPED", "NO_QCP", "WELD_MAP_UNCONFIRMED", "NO_JOINTS_FOR_STEPS", "H3_DATA_GAPS"]);
    expect(w[0]).toMatchObject({ items: ["Item 3", "Item 7"] });
    expect(w[0].message).toMatch(/^2 BOM lines have no part family/);
    expect(w[4].message).toMatch(/^1 joint on the weld map is not confirmed/);
    expect(w[5].message).toBe("No nozzle joints on the weld map: those weld steps will not be created.");
    expect(w[6].message).toMatch(/^4 pressure-retaining parts will start with no drawing/);
  });

  it("uses the singular for one", () => {
    expect(buildReleaseWarnings({ ...none, unmappedItemNos: [1] })[0].message).toMatch(/^1 BOM line has no part family/);
    expect(buildReleaseWarnings({ ...none, pressureParts: 1 })[0].message).toMatch(/^1 pressure-retaining part will/);
  });
});
