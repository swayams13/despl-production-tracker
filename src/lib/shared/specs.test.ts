import { describe, expect, it } from "vitest";
import { specFieldsFor, validateSpecs, SPEC_FIELDS } from "./specs";

describe("specFieldsFor", () => {
  it("returns the pressure-vessel field set", () => {
    const fields = specFieldsFor("PRESSURE_VESSEL");
    expect(fields.map((f) => f.key)).toContain("designPressure");
    expect(fields.find((f) => f.key === "designPressure")?.unit).toBe("kg/cm²");
  });

  it("returns an empty set for a family with no entry, rather than throwing", () => {
    // A family whose route exists but whose spec fields have not been defined
    // yet is a valid state — it stores specs: null, not an error.
    expect(specFieldsFor("PIPING_SYSTEM")).toEqual([]);
  });

  it("defines no duplicate keys within a family", () => {
    for (const [family, fields] of Object.entries(SPEC_FIELDS)) {
      const keys = fields.map((f) => f.key);
      expect(new Set(keys).size, `duplicate spec key in ${family}`).toBe(keys.length);
    }
  });

  it("gives every select field a non-empty options list", () => {
    for (const fields of Object.values(SPEC_FIELDS)) {
      for (const f of fields) {
        if (f.type === "select") expect(f.options?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("validateSpecs", () => {
  it("keeps only keys defined for the family", () => {
    const out = validateSpecs("PRESSURE_VESSEL", { designPressure: 10, sneaky: "x" });
    expect(out).toEqual({ designPressure: 10 });
  });

  it("coerces a numeric string for a number field", () => {
    expect(validateSpecs("PRESSURE_VESSEL", { designPressure: "10.5" })).toEqual({ designPressure: 10.5 });
  });

  it("drops a non-numeric value for a number field rather than storing junk", () => {
    expect(validateSpecs("PRESSURE_VESSEL", { designPressure: "abc" })).toEqual({});
  });

  it("drops a select value outside its options", () => {
    expect(validateSpecs("PRESSURE_VESSEL", { orientation: "Diagonal" })).toEqual({});
    expect(validateSpecs("PRESSURE_VESSEL", { orientation: "Vertical" })).toEqual({ orientation: "Vertical" });
  });

  it("returns an empty object for an unknown family", () => {
    expect(validateSpecs("NOT_A_FAMILY", { anything: 1 })).toEqual({});
  });
});
