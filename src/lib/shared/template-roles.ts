// Lean Core L1.2h: which role / joint / pressure facts a template version's steps are missing, from the
// reviewed mapping (seed/assembly-step-roles-pv-v1.json). Pure; the setup service and its script apply it.
// Fill-only: a value that is already set is never replaced (invariant 9: nothing published is edited,
// the caller copies into a NEW version).

export interface RoleFacts {
  role: string | null;
  jointRef: string | null;
  pressurePart: boolean;
}

export interface RolePlan {
  /** Steps that gain at least one fact, with only the facts they gain. */
  fills: Array<{ seq: number; set: Partial<RoleFacts> }>;
  /** Template steps the mapping has no row for. Not a mapping of this sequence: the caller refuses. */
  unmapped: number[];
  /** Mapping rows the template has no step for: same. */
  unknown: number[];
  /** Template steps that need nothing. */
  already: number;
}

export function planTemplateRoles(
  template: ReadonlyArray<RoleFacts & { seq: number }>,
  mapping: ReadonlyArray<RoleFacts & { seq: number }>,
): RolePlan {
  const bySeq = new Map(mapping.map((m) => [m.seq, m]));
  const plan: RolePlan = { fills: [], unmapped: [], unknown: [], already: 0 };
  for (const s of template) {
    const m = bySeq.get(s.seq);
    if (!m) {
      plan.unmapped.push(s.seq);
      continue;
    }
    const set: Partial<RoleFacts> = {};
    if (s.role == null && m.role != null) set.role = m.role;
    if (s.jointRef == null && m.jointRef != null) set.jointRef = m.jointRef;
    if (!s.pressurePart && m.pressurePart) set.pressurePart = true;
    if (Object.keys(set).length > 0) plan.fills.push({ seq: s.seq, set });
    else plan.already++;
  }
  const have = new Set(template.map((s) => s.seq));
  plan.unknown = mapping.filter((m) => !have.has(m.seq)).map((m) => m.seq);
  return plan;
}
