// Lean Core J4c: the workbook's "Assembly Sequence" sheet -> assembly template steps.
// Pure (no DB, no xlsx): rows and reference data in, steps and issues out, so every rule
// is table-tested. The mapping rules are the J-phase plan B.J4c; role and pressure
// inference and the pressure flag on seam/nozzle/skirt joints are PROVISIONAL (ratify SJ + QC
// head, as for the 54-step role mapping).

export type SequenceStepKind = "WORK" | "INSPECTION";
export type SequenceJointType = "LONG_SEAM" | "CIRC_SEAM" | "NOZZLE" | "ATTACHMENT";
export type SequenceRole = "FIT_UP" | "WELD" | "NDT" | "HEAT_TREATMENT" | "FINAL_PWHT" | "HYDRO";

export interface SequenceRowInput {
  /** Excel row number, kept so an issue can point at the cell to fix. */
  row: number;
  groupCode: string;
  groupName: string;
  stepNo: string;
  seq: string;
  activity: string;
  kind: string;
  partsUsed: string;
  jointRef: string;
  department: string;
  stage: string;
}

export interface SequenceContext {
  /** Department names as seeded, normalised with `normName`. */
  departmentIdByName: ReadonlyMap<string, number>;
  /** Codes of the family's published process route (the 36 lead-time processes). */
  processCodes: ReadonlySet<number>;
  /** Part codes of APPROVED, pressure-retaining part families. */
  pressureParts: ReadonlySet<string>;
}

export type SequenceSeverity = "ERROR" | "WARNING" | "INFO";
export interface SequenceIssue {
  row: number | null;
  severity: SequenceSeverity;
  code: string;
  message: string;
}

export interface MappedStep {
  seq: number;
  groupCode: string;
  groupName: string;
  srNo: string;
  activity: string;
  kind: SequenceStepKind;
  defaultDepartmentId: number;
  leadTimeProcessSeq: number | null;
  scope: "PER_UNIT" | "PER_JOINT";
  jointType: SequenceJointType | null;
  role: SequenceRole | null;
  pressurePart: boolean;
  /** D3 derives the final value at materialisation wherever `role` is set. */
  requiresQc: true;
  /** The sheet has no QC plan column yet; inspection steps stay unbound. */
  qcpSrNo: null;
  /** Excel rows this step came from (more than one after a collapse). */
  sourceRows: number[];
}

export interface Collapse {
  activity: string;
  jointRefs: string[];
  rows: number[];
}

export const normName = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

// ── Joint references ─────────────────────────────────────────────────────────

/** "LS-1", "NS-N1…N6", "GW-1...32", "N4": one token per joint reference in a cell. */
const REF_SPLIT = /\s*[/,;+&]\s*|\s+and\s+/i;
const clean = (s: string) => s.replace(/[…]|\.{3}/g, "…").replace(/\s+/g, " ").trim();

/** A joint-number token inside free text (activity names), used to collapse "(LS-1)" and "(LS-2)". */
const JOINT_TOKEN = /\b(?:LS|CS|NS|NF|SK|BR|GW)-[A-Z0-9]+(?:…[A-Z0-9n]+)?\b/gi;

export function jointTypeOfRef(token: string): SequenceJointType | null {
  const t = token.trim().toUpperCase();
  if (/^LS-\d/.test(t)) return "LONG_SEAM";
  if (/^CS-\d/.test(t)) return "CIRC_SEAM";
  if (/^(NS|NF)-/.test(t) || /^[NM]\d/.test(t)) return "NOZZLE";
  // ponytail: ATTACHMENT is one joint type, so a step on SK-1 expands over every attachment joint
  // (gussets, base ring) too; refs outside this list (NW-N1, LW-n, LS-SK) stay PER_UNIT, never guessed.
  if (/^(SK|BR|GW)-/.test(t)) return "ATTACHMENT";
  return null;
}

export type JointClassification =
  | { kind: "NONE" }
  | { kind: "JOINT"; jointType: SequenceJointType; refs: string[] }
  | { kind: "MIXED"; types: SequenceJointType[]; refs: string[] }
  | { kind: "UNKNOWN"; text: string };

export function classifyJointRef(cell: string): JointClassification {
  const text = clean(cell);
  if (!text) return { kind: "NONE" };
  const refs = text.split(REF_SPLIT).map((r) => r.trim()).filter(Boolean);
  const types = refs.map(jointTypeOfRef);
  if (types.some((t) => t == null)) return { kind: "UNKNOWN", text };
  const distinct = [...new Set(types as SequenceJointType[])];
  return distinct.length === 1 ? { kind: "JOINT", jointType: distinct[0], refs } : { kind: "MIXED", types: distinct, refs };
}

// ── Role inference (provisional) ─────────────────────────────────────────────

const DOC_RE = /\b(compile|records?|documents?|documentation)\b/;
const NDT_RE = /\b(rt|ut|pt|mpt|lpt|mt|paut|tofd|ndt|nde|radiograph\w*|ultrasonic)\b|weld visual|visual of/;
const GATE_RE = /\b(clearance|before|prior to|ready for|after|drain\w*)\b/;

export function inferRole(kind: SequenceStepKind, activity: string): SequenceRole | null {
  // "post-PWHT NDE" is an examination, not the heat treatment.
  const a = activity.toLowerCase().replace(/post[- ]?pwht/g, " ");
  if (DOC_RE.test(a)) return null;
  if (NDT_RE.test(a)) return "NDT";
  if (!GATE_RE.test(a)) {
    if (/hydro/.test(a)) return "HYDRO";
    if (/\bpwht\b|post[- ]weld heat/.test(a)) return "FINAL_PWHT";
    if (/pfht|post[- ]forming|heat treat/.test(a)) return "HEAT_TREATMENT";
  }
  if (kind === "WORK") {
    if (/\bweld(s|ing)?\b/.test(a)) return "WELD";
    if (/\b(fit|fit-up|fitted|set ?up)\b/.test(a)) return "FIT_UP";
  }
  return null;
}

// ── Mapping ──────────────────────────────────────────────────────────────────

const PERJOINT_PRESSURE: ReadonlySet<SequenceJointType> = new Set(["LONG_SEAM", "CIRC_SEAM", "NOZZLE"]);

/** A joint step's activity names no single joint: "Weld Of Shell (LS-1)" -> "Weld Of Shell". */
function stripJoints(activity: string): string {
  return clean(
    clean(activity)
      .replace(/\s*\(\s*(?:LS|CS|NS|NF|SK|BR|GW)-[A-Z0-9…n]+\s*\)/gi, "")
      .replace(JOINT_TOKEN, "the joint"),
  );
}

interface Draft {
  step: MappedStep;
  refs: string[];
  /** Activity with joint numbers masked, for the collapse comparison. */
  key: string;
}

/**
 * Rows -> steps. A row with an ERROR is refused (left out); the caller must not import
 * while any ERROR remains, so a sequence is never saved with a hole in it.
 */
export function mapAssemblySequence(
  rows: readonly SequenceRowInput[],
  ctx: SequenceContext,
): { steps: MappedStep[]; collapses: Collapse[]; issues: SequenceIssue[] } {
  const issues: SequenceIssue[] = [];
  const add = (row: number | null, severity: SequenceSeverity, code: string, message: string) =>
    issues.push({ row, severity, code, message });

  // Order: by the sheet's Seq when every row has a number, otherwise as the rows come.
  const nums = rows.map((r) => (/^\d+(\.\d+)?$/.test(r.seq.trim()) ? Number(r.seq) : null));
  const ordered = rows.map((r, i) => ({ r, n: nums[i], i }));
  if (nums.every((n) => n != null)) ordered.sort((a, b) => a.n! - b.n! || a.i - b.i);
  else if (rows.length > 0) add(null, "WARNING", "SEQ_NOT_NUMERIC", "Not every row has a number in the Seq column, so the rows are taken in sheet order.");

  const drafts: Draft[] = [];
  let unknownJointRows = 0;
  for (const { r } of ordered) {
    let refused = false;
    const refuse = (code: string, message: string) => {
      add(r.row, "ERROR", code, message);
      refused = true;
    };

    const kindKey = r.kind.trim().toLowerCase();
    const kind: SequenceStepKind | null = kindKey === "work" ? "WORK" : kindKey === "inspection" ? "INSPECTION" : null;
    if (!kind) refuse("KIND_UNKNOWN", `Kind "${r.kind}" must be Work or Inspection.`);

    const departmentId = ctx.departmentIdByName.get(normName(r.department));
    if (departmentId == null) refuse("DEPARTMENT_UNKNOWN", `Department "${r.department}" is not a department in the tracker.`);

    let leadTimeProcessSeq: number | null = null;
    if (r.stage.trim() !== "") {
      const n = /^\d+$/.test(r.stage.trim()) ? Number(r.stage) : NaN;
      if (!ctx.processCodes.has(n)) refuse("PROCESS_UNKNOWN", `"Counts toward stage no." ${r.stage} is not a process of the published route.`);
      else leadTimeProcessSeq = n;
    }
    if (!r.groupCode.trim()) refuse("GROUP_CODE_BLANK", "The group code is blank.");

    const joint = classifyJointRef(r.jointRef);
    if (joint.kind === "MIXED") {
      refuse("JOINT_REF_MIXED", `Joint reference "${r.jointRef}" mixes ${joint.types.join(" and ")} joints; split it into one row per type.`);
    }
    if (joint.kind === "UNKNOWN") {
      unknownJointRows++;
      add(r.row, "WARNING", "JOINT_REF_UNRECOGNISED", `Joint reference "${joint.text}" is not a joint number the tracker knows, so this step is not tied to a joint.`);
    }
    if (refused || !kind || departmentId == null) continue;

    const jointType = joint.kind === "JOINT" ? joint.jointType : null;
    const refs = joint.kind === "JOINT" ? joint.refs : [];
    const role = inferRole(kind, r.activity);
    if (role === "FINAL_PWHT" && /pfht|post[- ]forming/i.test(r.activity)) {
      add(r.row, "WARNING", "ROLE_AMBIGUOUS", `"${clean(r.activity)}" covers forming heat treatment and PWHT in one step; marked as the final PWHT. Split it if only one applies.`);
    }
    const partCodes = r.partsUsed.match(/\b[A-Z]{2,4}-\d{2}\b/g) ?? [];
    const pressurePart =
      partCodes.some((c) => ctx.pressureParts.has(c)) ||
      (jointType != null && (PERJOINT_PRESSURE.has(jointType) || refs.some((x) => /^SK-/i.test(x))));
    drafts.push({
      refs,
      key: jointType ? stripJoints(r.activity) : clean(r.activity),
      step: {
        seq: 0,
        groupCode: r.groupCode.trim(),
        groupName: clean(r.groupName) || r.groupCode.trim(),
        srNo: r.stepNo.trim(),
        activity: jointType ? stripJoints(r.activity) : clean(r.activity),
        kind,
        defaultDepartmentId: departmentId,
        leadTimeProcessSeq,
        scope: jointType ? "PER_JOINT" : "PER_UNIT",
        jointType,
        role,
        pressurePart,
        requiresQc: true,
        qcpSrNo: null,
        sourceRows: [r.row],
      },
    });
  }

  // Collapse consecutive rows that differ only by joint number.
  const collapsed: Draft[] = [];
  const collapses: Collapse[] = [];
  for (const d of drafts) {
    const prev = collapsed[collapsed.length - 1];
    const same =
      prev &&
      d.step.jointType != null &&
      prev.step.jointType === d.step.jointType &&
      prev.step.kind === d.step.kind &&
      prev.step.defaultDepartmentId === d.step.defaultDepartmentId &&
      prev.key === d.key &&
      d.refs.some((x) => !prev.refs.includes(x));
    if (!same) {
      collapsed.push({ ...d, step: { ...d.step, sourceRows: [...d.step.sourceRows] }, refs: [...d.refs] });
      continue;
    }
    prev.step.sourceRows.push(...d.step.sourceRows);
    prev.step.pressurePart ||= d.step.pressurePart;
    prev.step.role ??= d.step.role;
    prev.refs.push(...d.refs.filter((x) => !prev.refs.includes(x)));
  }
  const steps = collapsed.map((d, i) => {
    if (d.step.sourceRows.length > 1) collapses.push({ activity: d.step.activity, jointRefs: d.refs, rows: d.step.sourceRows });
    return { ...d.step, seq: i + 1 };
  });

  // The same joint step repeated apart from its twin (fit LS-1, weld LS-1, fit LS-2 ...) would expand twice per joint.
  const seen = new Map<string, MappedStep>();
  for (const s of steps) {
    if (s.scope !== "PER_JOINT") continue;
    const k = JSON.stringify([s.kind, s.defaultDepartmentId, s.jointType, s.activity]);
    const first = seen.get(k);
    if (first) add(s.sourceRows[0], "WARNING", "JOINT_STEP_REPEATED", `"${s.activity}" repeats row ${first.sourceRows[0]}: a joint step applies to every joint of its type, so list it once.`);
    else seen.set(k, s);
  }

  // Summary notes, once each, so a 30-row sheet does not bury the real errors.
  const inferred = steps.filter((s) => s.role != null).length;
  if (inferred > 0) add(null, "WARNING", "ROLES_INFERRED", `${inferred} step(s) got a role (fit-up, weld, NDT, heat treatment, hydro) guessed from the activity text. Check the Role column; the Production Head and QC head confirm.`);
  const unbound = steps.filter((s) => s.kind === "INSPECTION").length;
  if (unbound > 0) add(null, "WARNING", "INSPECTION_UNBOUND", `${unbound} inspection step(s) are not linked to a QC plan checkpoint: the sheet has no QC plan column.`);
  if (unknownJointRows > 0) add(null, "INFO", "JOINT_REFS_SKIPPED", `${unknownJointRows} row(s) had a joint reference that is not a joint number.`);
  if (rows.length > 0 && steps.length === 0 && !issues.some((i) => i.severity === "ERROR")) add(null, "ERROR", "NO_STEPS", "No steps could be read.");

  return { steps, collapses, issues };
}

/** True when a step needs the planned seams (long and circumferential), which come from the shell_courses answer. */
export const isSeamDriven = (s: { scope: string; jointType: string | null }): boolean =>
  s.scope === "PER_JOINT" && (s.jointType === "LONG_SEAM" || s.jointType === "CIRC_SEAM");

/** Everything a step carries that a version publishes: same content = same sequence. */
export function sequenceSignature(
  steps: ReadonlyArray<{
    seq: number; groupCode: string; groupName: string; srNo: string; activity: string; kind: string; defaultDepartmentId: number;
    leadTimeProcessSeq: number | null; scope: string; jointType: string | null; role: string | null; pressurePart: boolean;
  }>,
): string {
  return JSON.stringify(
    steps.map((s) => [s.seq, s.groupCode, s.groupName, s.srNo, s.activity, s.kind, s.defaultDepartmentId, s.leadTimeProcessSeq, s.scope, s.jointType, s.role, s.pressurePart]),
  );
}
