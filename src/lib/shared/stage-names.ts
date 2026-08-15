/**
 * The 25 work-order stage names (DESIGN_SPEC §11.1), sourced from
 * `seed/lead-time-model.json` → `workOrderStageNames.names`.
 *
 * Kept in TS rather than baked into the SQL view: names are pure display, the
 * anti-drift concern §11.5 raises is about status/counts (not labels), and C27
 * is unresolved — SJ may swap these for the shop-floor fabrication scheme. When
 * that lands it's a one-line edit here, not a new immutable migration.
 */
export const STAGE_NAMES: Record<number, string> = {
  1: "Project Kick-Off",
  2: "Engineering Review",
  3: "Detail Engineering",
  4: "BOM Preparation",
  5: "Material Procurement",
  6: "Incoming Material Inspection",
  7: "Cutting",
  8: "Forming",
  9: "Edge Preparation",
  10: "Shell Fabrication",
  11: "Head Assembly",
  12: "Nozzle Fabrication",
  13: "Nozzle Fit-up",
  14: "Saddle Fabrication",
  15: "Accessories",
  16: "Dimensional Inspection",
  17: "NDT",
  18: "PWHT",
  19: "Hydro Test",
  20: "Surface Preparation",
  21: "Painting",
  22: "Final Inspection",
  23: "Documentation (MDR)",
  24: "Packing",
  25: "Dispatch",
};

export function stageName(stageNo: number): string {
  return STAGE_NAMES[stageNo] ?? `Stage ${stageNo}`;
}
