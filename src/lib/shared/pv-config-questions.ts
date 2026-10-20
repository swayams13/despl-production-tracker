// Lean Core J2: the pressure-vessel design questions, moved out of the
// hard-coded SPEC_FIELDS (ADR B11 retired) into config_questions rows. Same
// seven fields, snake_case keys, plus J4a's shell_courses (drives the generated
// seams). Further ones (e.g. whether PWHT applies) arrive with the DE0423 content (J5/M2).
import type { ConfigQuestionDef } from "./config-questions";

export const PV_CONFIG_QUESTIONS: readonly ConfigQuestionDef[] = [
  { key: "design_pressure", label: "Design pressure", type: "NUMBER", unit: "kg/cm²" },
  { key: "design_temperature", label: "Design temperature", type: "NUMBER", unit: "°C" },
  { key: "mdmt", label: "MDMT", type: "NUMBER", unit: "°C" },
  { key: "moc", label: "Material of construction", type: "TEXT" },
  { key: "capacity", label: "Capacity", type: "NUMBER", unit: "L" },
  { key: "orientation", label: "Orientation", type: "SELECT", options: ["Vertical", "Horizontal"] },
  { key: "radiography", label: "Radiography", type: "SELECT", options: ["Full", "Spot", "None"] },
  { key: "shell_courses", label: "Shell courses", type: "NUMBER", help: "Number of rolled shell courses; sets the long and circumferential seams" },
];

/** The old camelCase spec keys, as stored in Job.specs and EquipmentTypeRef.defaultSpecs. */
export const LEGACY_SPEC_KEYS: Readonly<Record<string, string>> = {
  designPressure: "design_pressure",
  designTemperature: "design_temperature",
  mdmt: "mdmt",
  moc: "moc",
  capacity: "capacity",
  orientation: "orientation",
  radiography: "radiography",
};
