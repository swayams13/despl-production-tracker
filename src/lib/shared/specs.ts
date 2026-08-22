/**
 * Design configuration captured at job intake, per product family.
 *
 * A constant map, not an EAV table: the field set changes when a product
 * family is added, which is a code change anyway, and one jsonb column serves
 * every family instead of one migration each.
 *
 * These values are DISPLAY AND REFERENCE DATA. Nothing in lib/schedule/ or the
 * gating path may read them — the moment a computed date depends on a
 * free-shaped blob, the product's refusals stop being explainable
 * (invariant #12).
 */

export interface SpecField {
  key: string;
  label: string;
  type: "number" | "text" | "select";
  unit?: string;
  options?: string[];
}

/**
 * PRESSURE_VESSEL is the only entry defined today, because it is the only
 * family with a published route. Each further family's fields land alongside
 * its route — heat exchangers will want TEMA type, shell- and tube-side design
 * pressure and temperature, tube count, tube OD and pass count — not here,
 * ahead of the route that makes them orderable.
 */
export const SPEC_FIELDS: Record<string, SpecField[]> = {
  PRESSURE_VESSEL: [
    { key: "designPressure", label: "Design pressure", type: "number", unit: "kg/cm²" },
    { key: "designTemperature", label: "Design temperature", type: "number", unit: "°C" },
    { key: "mdmt", label: "MDMT", type: "number", unit: "°C" },
    { key: "moc", label: "Material of construction", type: "text" },
    { key: "capacity", label: "Capacity", type: "number", unit: "L" },
    { key: "orientation", label: "Orientation", type: "select", options: ["Vertical", "Horizontal"] },
    { key: "radiography", label: "Radiography", type: "select", options: ["Full", "Spot", "None"] },
  ],
};

/** Fields for a family code. An undefined family is a valid empty set, not an error. */
export function specFieldsFor(familyCode: string): SpecField[] {
  return SPEC_FIELDS[familyCode] ?? [];
}

/**
 * Keep only keys defined for the family, coerced to their declared type.
 * Anything unrecognised or uncoercible is DROPPED rather than stored: a jsonb
 * column will accept literally anything, so this is the only thing standing
 * between a typo in a form post and permanent junk in the record.
 */
export function validateSpecs(
  familyCode: string,
  specs: Record<string, unknown>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const field of specFieldsFor(familyCode)) {
    const raw = specs[field.key];
    if (raw == null || raw === "") continue;

    if (field.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (Number.isFinite(n)) out[field.key] = n;
      continue;
    }
    const s = String(raw).trim();
    if (s === "") continue;
    if (field.type === "select" && !(field.options ?? []).includes(s)) continue;
    out[field.key] = s;
  }
  return out;
}
