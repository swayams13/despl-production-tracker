// Lean Core J1: where an equipment type's component quantity comes from.
// Mirrors the CHECK on equipment_type_components.qty_source. Configuration
// only: nothing here is read by scheduling or gating (J5 reads it at BOM release).

export type QtySource =
  | { kind: "FIXED" }
  | { kind: "NOZZLE_SCHEDULE" }
  | { kind: "ANSWER"; key: string };

const ANSWER_RE = /^ANSWER:([a-z][a-z0-9_]*)$/;

/** Null when the string is not one of FIXED | NOZZLE_SCHEDULE | ANSWER:<snake_key>. */
export function parseQtySource(raw: string): QtySource | null {
  if (raw === "FIXED") return { kind: "FIXED" };
  if (raw === "NOZZLE_SCHEDULE") return { kind: "NOZZLE_SCHEDULE" };
  const m = ANSWER_RE.exec(raw);
  return m ? { kind: "ANSWER", key: m[1] } : null;
}

/**
 * The pressure-vessel equipment types DESPL proposes (decision D18, still open).
 * Only the skirt type is active and carries a template and a kit: the other
 * two would otherwise fall back to DESPL-320's vertical-vessel steps.
 */
export const PV_EQUIPMENT_TYPES = [
  { code: "PV-VERT-SKIRT", name: "Vertical vessel on skirt", active: true },
  { code: "PV-VERT-LEGS", name: "Vertical vessel on legs", active: false },
  { code: "PV-HORZ-SADDLE", name: "Horizontal vessel on saddles", active: false },
] as const;

/** DESPL-320's 11 components per unit, the kit of "vertical on skirt" (FIXED). */
export const PV_SKIRT_KIT: readonly { componentTypeCode: string; defaultQty: number }[] = [
  { componentTypeCode: "PLATE", defaultQty: 1 },
  { componentTypeCode: "DISHED_END", defaultQty: 2 },
  { componentTypeCode: "SKIRT", defaultQty: 1 },
  { componentTypeCode: "FORGING", defaultQty: 2 },
  { componentTypeCode: "FLANGE", defaultQty: 1 },
  { componentTypeCode: "PIPE", defaultQty: 1 },
  { componentTypeCode: "COUPLING", defaultQty: 3 },
];
