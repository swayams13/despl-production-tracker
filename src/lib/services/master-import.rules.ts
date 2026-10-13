import aliases from "../../../seed/standard-parts-aliases.json";
import type { ParsedWorkbook, Severity } from "./master-import.parse";

/**
 * Lean Core M2 — the importer's rules. Pure: parsed workbook + reference data
 * in, issues and per-row load decisions out. No DB, so every rule is
 * table-testable. Nothing here guesses: a label that is not in
 * `seed/standard-parts-aliases.json` (or not a tracker code) is reported.
 *
 * ERROR  = the row (or the part's route variant) is not loaded.
 * WARNING = loads, as a DRAFT, and is flagged for the Production Head.
 * INFO   = report only.
 *
 * Routes load atomically per (part, variant): one bad step blocks that
 * variant, never half a route. A part family is still created when only its
 * route is blocked.
 */

export const ISSUE_CODES = [
  "SHEET_MISSING",
  "COLUMN_MISSING",
  "INVALID_VALUE",
  "DUPLICATE_PART_CODE",
  "NOT_APPROVED",
  "ASSUMED_ROUTE_APPROVED",
  "UNKNOWN_RAW_FORM",
  "UNKNOWN_PART",
  "UNKNOWN_OPERATION",
  "UNKNOWN_DEPARTMENT",
  "MISSING_DEPARTMENT",
  "MISSING_STAGE",
  "UNKNOWN_STAGE_NUMBER",
  "DUPLICATE_STEP",
  "UNKNOWN_TIME_BASIS",
  "MISSING_STD_TIME",
  "PROPOSED_STD_TIME",
  "STAGE_DIFFERS_FROM_OPERATION_DEFAULT",
  "DEPARTMENT_STAGE_MISMATCH",
  "POSSIBLE_FILL_DOWN",
  "PART_WITHOUT_ROUTE",
  "VARIANT_GAP",
  "DUPLICATE_MATERIAL",
  "MISSING_DENSITY",
  "DUPLICATE_STAGE",
  "UNKNOWN_PREDECESSOR",
  "ASSEMBLY_UNKNOWN_PART",
  "NEW_OPERATION_PENDING",
  "REVIEW_ACTION_OPEN",
  // State of the tenant's existing master data (set by the service, not the pure rules).
  "PART_CODE_CONFLICT",
  "STATUS_DOWNGRADE",
  "REVIEW_BY_PREPARER",
  "MATERIAL_LOCKED",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface ImportIssue {
  code: IssueCode;
  severity: Severity;
  sheet: string;
  row: number | null;
  partCode?: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface ReferenceData {
  /** Tenant OperationRef codes. */
  operationCodes: ReadonlySet<string>;
  /** PV `OperationRefFamilySeq`: operation code -> default stage number. */
  operationDefaultStage: ReadonlyMap<string, number>;
  /** Tenant Department names. */
  departmentNames: ReadonlySet<string>;
  /** Tenant ComponentTypeRef codes (a mapped raw form must exist here). */
  componentTypeCodes: ReadonlySet<string>;
  /** The 36 PV stages (tracker's own template, or the workbook's reference sheet). */
  pvStages: ReadonlyMap<number, { name: string; department: string | null }>;
}

export interface EvaluateOptions {
  /** Production refuses anything not "Approved by Production Head"; staging may load Drafts. */
  allowDraft: boolean;
}

export type MasterStatus = "DRAFT" | "REVIEWED" | "APPROVED";
export type Scope = "PV" | "HE" | "BOTH";

export interface NormalStep {
  row: number;
  seq: number;
  operationCode: string;
  whatIsDone: string;
  department: string;
  pvStage: number | null;
  heStage: number | null;
  stdTime: number | null;
  stdTimeUnit: string | null;
  stdTimeBasis: string | null;
  conditional: boolean;
  conditionText: string;
  acceptanceStandard: string;
  recordDocument: string;
  /** Step-level QC (effective QC = this AND the operation's). The workbook has no column: true. */
  requiresQc: boolean;
}

export interface VariantDecision {
  variant: string;
  steps: NormalStep[];
  load: boolean;
}

export interface PartDecision {
  row: number;
  code: string;
  name: string;
  scope: Scope | null;
  status: MasterStatus | null;
  assemblyGroup: string;
  makeBuy: string | null;
  /** Resolved tracker component-type code; null = none (assembly / catalogue item, or unknown). */
  rawFormCode: string | null;
  typicalMoc: string;
  dimensions: string;
  weightBasis: string;
  isSpare: boolean;
  routeSource: string;
  /** The part family row will be written. */
  load: boolean;
  variants: VariantDecision[];
}

export interface MaterialDecision {
  row: number;
  spec: string;
  grade: string;
  productForm: string;
  densityGcc: number | null;
  remarks: string;
  load: boolean;
}

export interface HeStageDecision {
  row: number;
  stageNo: number;
  name: string;
  activities: string;
  department: string;
  minDays: number | null;
  maxDays: number | null;
  predecessors: number[];
  linkType: string | null;
  lagDays: number;
  optional: boolean;
  optionalWhen: string;
}

export interface Evaluation {
  issues: ImportIssue[];
  parts: PartDecision[];
  materials: MaterialDecision[];
  heStages: HeStageDecision[];
  /** All-or-nothing: a template with a broken stage is not loaded. */
  heLoadable: boolean;
}

const OPERATIONS = aliases.operations as Record<string, string>;
const RAW_FORMS = aliases.rawForms as Record<string, string | null>;
const MAKE_BUY = aliases.makeBuy as Record<string, string>;
const EQUIPMENT = aliases.equipment as Record<string, Scope>;
const STATUS = aliases.status as Record<string, MasterStatus>;
const TIME_UNIT = aliases.timeUnit as Record<string, string>;
const TIME_BASIS = aliases.timeBasis as Record<string, string>;
const LINK_TYPE = aliases.linkType as Record<string, string>;

/**
 * The workbook's "Dimensions to enter per job" is free text: mostly a comma
 * list of keys ("OD, thickness, hole count"), sometimes keys carrying sample
 * values ("ID 3000; thickness 10") or example clauses ("SP40: OD 21.3 × 0.4").
 * The keys are what a planner enters per job; sample numbers are never stored.
 * Trailing numbers and units are stripped; an item that still contains a digit
 * (a spec such as "2:1 semi-ellipsoidal", an example clause) is not a key.
 * Best effort for a DRAFT the Production Head reviews, not a parser of record.
 */
const VALUE_TOKEN = /^(mm|cm|m|kg|in|min|max|thk|x|×|to|and|%|deg|°)$/i;

export function deriveDimensionKeys(text: string): string[] {
  const keys: string[] = [];
  for (const item of text.split(/[;,\n]+/)) {
    const tokens = item.trim().split(/\s+/).filter(Boolean);
    while (tokens.length > 1 && (/^[\d.]/.test(tokens[tokens.length - 1]) || VALUE_TOKEN.test(tokens[tokens.length - 1]))) tokens.pop();
    const key = tokens.join(" ").replace(/[,.:]+$/, "").trim();
    if (!key || /\d/.test(key)) continue;
    if (!keys.some((k) => k.toLowerCase() === key.toLowerCase())) keys.push(key);
  }
  return keys;
}

const intOrNull = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s) : null);
const decimalOrNull = (s: string): number | null => (/^\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : null);
const yes = (s: string): boolean => /^y(es)?$/i.test(s.trim());

/** Stable comparison key for a route step; shared by the dry-run and (PR B) apply. */
export function stepSignature(s: Pick<NormalStep, "seq" | "operationCode" | "whatIsDone" | "department" | "stdTime" | "stdTimeUnit" | "stdTimeBasis" | "conditional" | "conditionText" | "acceptanceStandard" | "recordDocument" | "requiresQc" | "pvStage" | "heStage">): string {
  return JSON.stringify([
    s.seq,
    s.operationCode,
    s.whatIsDone,
    s.department,
    s.stdTime == null ? null : Number(s.stdTime),
    s.stdTimeUnit,
    s.stdTimeBasis,
    s.conditional,
    s.conditionText,
    s.acceptanceStandard,
    s.recordDocument,
    s.requiresQc,
    s.pvStage,
    s.heStage,
  ]);
}

export interface StepCheckInput {
  scope: Scope | null;
  partCode: string;
  /** Operation as the caller names it (workbook label or operation name), for messages. */
  operationLabel: string;
  /** Tracker operation code; null when the caller already reported it as unknown. */
  operationCode: string | null;
  department: string;
  /** The step number as typed, for messages. */
  seqText: string;
  pvStage: number | null;
  heStage: number | null;
  /** true = nothing was entered; false with a null stage = an invalid entry the caller reported. */
  pvBlank: boolean;
  heBlank: boolean;
}

export interface StepFinding {
  code: IssueCode;
  severity: Severity;
  message: string;
  meta?: Record<string, unknown>;
}

/**
 * Checks one route step against the tracker's own vocabulary and stages. The
 * single source of these rules: the importer calls it per workbook row and the
 * Master data editor / approval call it per saved step, so a route cannot be
 * saved or approved under looser rules than it was imported under.
 */
export function checkStep(
  c: StepCheckInput,
  ref: ReferenceData,
  heStages: ReadonlyMap<number, { department: string }>,
): StepFinding[] {
  const out: StepFinding[] = [];
  const err = (code: IssueCode, message: string, meta?: Record<string, unknown>) =>
    out.push({ code, severity: "ERROR", message, meta });
  const warn = (code: IssueCode, message: string, meta?: Record<string, unknown>) =>
    out.push({ code, severity: "WARNING", message, meta });

  if (c.operationCode && !ref.operationCodes.has(c.operationCode)) {
    err("UNKNOWN_OPERATION", `Operation "${c.operationLabel}" maps to ${c.operationCode}, which does not exist in the tracker.`, { operation: c.operationLabel, operationCode: c.operationCode });
  }
  if (!c.department) err("MISSING_DEPARTMENT", `Step ${c.seqText} of ${c.partCode} has no department.`);
  else if (!ref.departmentNames.has(c.department)) err("UNKNOWN_DEPARTMENT", `Department "${c.department}" is not a tracker department.`, { department: c.department });

  const wantPv = c.scope === "PV" || c.scope === "BOTH";
  const wantHe = c.scope === "HE" || c.scope === "BOTH";
  const missing = [wantPv && c.pvBlank ? "PV" : null, wantHe && c.heBlank ? "HE" : null].filter(Boolean);
  if (missing.length > 0) err("MISSING_STAGE", `Step ${c.seqText} of ${c.partCode} has no ${missing.join(" or ")} stage number.`, { missing });
  if (c.pvStage != null && !ref.pvStages.has(c.pvStage)) err("UNKNOWN_STAGE_NUMBER", `PV stage ${c.pvStage} is not one of the tracker's PV stages.`, { family: "PV", stage: c.pvStage });
  if (c.heStage != null && !heStages.has(c.heStage)) err("UNKNOWN_STAGE_NUMBER", `HE stage ${c.heStage} is not in the HE Stages sheet.`, { family: "HE", stage: c.heStage });

  // Plausibility (warnings): is this the stage this operation normally counts toward?
  if (c.pvStage != null && c.operationCode) {
    const def = ref.operationDefaultStage.get(c.operationCode);
    if (def != null && def !== c.pvStage) {
      warn("STAGE_DIFFERS_FROM_OPERATION_DEFAULT", `${c.operationLabel} normally counts toward PV stage ${def}, but step ${c.seqText} of ${c.partCode} says ${c.pvStage}.`, { operationCode: c.operationCode, operationDefault: def, pvStage: c.pvStage });
    }
  }
  if (c.department) {
    const pvDept = c.pvStage != null ? ref.pvStages.get(c.pvStage)?.department : null;
    if (pvDept && pvDept !== c.department) warn("DEPARTMENT_STAGE_MISMATCH", `Step ${c.seqText} of ${c.partCode} is done by ${c.department} but PV stage ${c.pvStage} belongs to ${pvDept}.`, { family: "PV", stage: c.pvStage, stageDepartment: pvDept, department: c.department });
    const heDept = c.heStage != null ? heStages.get(c.heStage)?.department : null;
    if (heDept && heDept !== c.department) warn("DEPARTMENT_STAGE_MISMATCH", `Step ${c.seqText} of ${c.partCode} is done by ${c.department} but HE stage ${c.heStage} belongs to ${heDept}.`, { family: "HE", stage: c.heStage, stageDepartment: heDept, department: c.department });
  }
  return out;
}

export function evaluateMaster(wb: ParsedWorkbook, ref: ReferenceData, opts: EvaluateOptions): Evaluation {
  const issues: ImportIssue[] = [];
  const add = (
    code: IssueCode,
    severity: Severity,
    sheet: string,
    row: number | null,
    message: string,
    extra: { partCode?: string; meta?: Record<string, unknown> } = {},
  ) => issues.push({ code, severity, sheet, row, message, ...extra });

  for (const p of wb.problems) add(p.code, "ERROR", p.sheet, p.row, p.message);

  // ── HE stages (needed first: HE stage numbers validate route steps) ────
  const heStages: HeStageDecision[] = [];
  const heNumbers = new Map<number, { department: string }>();
  let heErrors = 0;
  const heErr = (code: IssueCode, row: number, message: string, meta?: Record<string, unknown>) => {
    heErrors++;
    add(code, "ERROR", "HE Stages", row, message, { meta });
  };
  for (const r of wb.heStages) {
    const stageNo = intOrNull(r.stageNo);
    if (stageNo == null) {
      heErr("INVALID_VALUE", r.row, `Stage number "${r.stageNo}" is not a whole number.`, { field: "stageNo" });
      continue;
    }
    if (heNumbers.has(stageNo)) {
      heErr("DUPLICATE_STAGE", r.row, `HE stage ${stageNo} appears more than once.`, { stageNo });
      continue;
    }
    heNumbers.set(stageNo, { department: r.department });
    if (!r.department || !ref.departmentNames.has(r.department)) {
      heErr("UNKNOWN_DEPARTMENT", r.row, `HE stage ${stageNo}: department "${r.department}" is not a tracker department.`, { stageNo, department: r.department });
    }
    const min = r.minDays === "" ? null : intOrNull(r.minDays);
    const max = r.maxDays === "" ? null : intOrNull(r.maxDays);
    if ((r.minDays !== "" && min == null) || (r.maxDays !== "" && max == null) || (min != null && max != null && min > max)) {
      heErr("INVALID_VALUE", r.row, `HE stage ${stageNo}: duration min/max must be whole days with min ≤ max.`, { field: "duration", min: r.minDays, max: r.maxDays });
    }
    const linkType = r.linkType ? (LINK_TYPE[r.linkType] ?? null) : null;
    if (r.linkType && !linkType) {
      heErr("INVALID_VALUE", r.row, `HE stage ${stageNo}: link type "${r.linkType}" is not recognised.`, { field: "linkType" });
    }
    const preds = /^[—–-]?$/.test(r.predecessors.trim())
      ? []
      : r.predecessors.split(/[\s,;]+/).filter(Boolean).map((t) => intOrNull(t));
    if (preds.some((p) => p == null)) {
      heErr("INVALID_VALUE", r.row, `HE stage ${stageNo}: predecessor list "${r.predecessors}" is not a list of stage numbers.`, { field: "predecessors" });
    }
    heStages.push({
      row: r.row,
      stageNo,
      name: r.name,
      activities: r.activities,
      department: r.department,
      minDays: min,
      maxDays: max,
      predecessors: preds.filter((p): p is number => p != null),
      linkType,
      lagDays: intOrNull(r.lag) ?? 0,
      optional: yes(r.optional),
      optionalWhen: r.optionalWhen,
    });
  }
  for (const s of heStages) {
    for (const p of s.predecessors) {
      if (!heNumbers.has(p)) heErr("UNKNOWN_PREDECESSOR", s.row, `HE stage ${s.stageNo}: predecessor ${p} is not a stage in this sheet.`, { stageNo: s.stageNo, predecessor: p });
    }
  }

  // ── Parts ───────────────────────────────────────────────────────────────
  const parts: PartDecision[] = [];
  const partByCode = new Map<string, PartDecision>();
  for (const r of wb.parts) {
    const at = (code: IssueCode, severity: Severity, message: string, meta?: Record<string, unknown>) =>
      add(code, severity, "Parts Master", r.row, message, { partCode: r.code, meta });
    if (partByCode.has(r.code)) {
      at("DUPLICATE_PART_CODE", "ERROR", `Part code ${r.code} appears more than once; the first row is used.`, { firstRow: partByCode.get(r.code)!.row });
      continue;
    }
    let load = true;
    const scope = EQUIPMENT[r.equipment] ?? null;
    if (!scope) {
      at("INVALID_VALUE", "ERROR", `Equipment "${r.equipment}" is not PV, HE or PV + HE.`, { field: "equipment" });
      load = false;
    }
    const status = STATUS[r.status] ?? null;
    if (!status) {
      at("INVALID_VALUE", "ERROR", `Status "${r.status}" is not Draft, Reviewed or Approved by Production Head.`, { field: "status" });
      load = false;
    } else if (status !== "APPROVED" && !opts.allowDraft) {
      at("NOT_APPROVED", "ERROR", `${r.code} is "${r.status}", not "Approved by Production Head"; production does not load it.`, { status: r.status });
      load = false;
    } else if (status === "APPROVED" && /^assumed/i.test(r.routeSource.trim())) {
      at("ASSUMED_ROUTE_APPROVED", "ERROR", `${r.code} is marked approved but its route source is "${r.routeSource}"; confirm the route before approving.`, { routeSource: r.routeSource });
      load = false;
    }
    let rawFormCode: string | null = null;
    if (r.rawForm) {
      if (r.rawForm in RAW_FORMS) {
        rawFormCode = RAW_FORMS[r.rawForm];
        if (rawFormCode && !ref.componentTypeCodes.has(rawFormCode)) {
          at("UNKNOWN_RAW_FORM", "WARNING", `Raw material form "${r.rawForm}" maps to ${rawFormCode}, which does not exist in the tracker; the part loads without one.`, { rawForm: r.rawForm, rawFormCode });
          rawFormCode = null;
        }
      } else at("UNKNOWN_RAW_FORM", "WARNING", `Raw material form "${r.rawForm}" has no tracker component type; the part loads without one.`, { rawForm: r.rawForm });
    }
    let makeBuy: string | null = null;
    if (r.makeBuy) {
      makeBuy = MAKE_BUY[r.makeBuy] ?? null;
      if (!makeBuy) at("INVALID_VALUE", "WARNING", `Make / Buy "${r.makeBuy}" is not one of the four tracker values; stored empty.`, { field: "makeBuy" });
    }
    const decision: PartDecision = {
      row: r.row,
      code: r.code,
      name: r.name,
      scope,
      status,
      assemblyGroup: r.assemblyGroup,
      makeBuy,
      rawFormCode,
      typicalMoc: r.typicalMoc,
      dimensions: r.dimensions,
      weightBasis: r.weightBasis,
      isSpare: yes(r.spare),
      routeSource: r.routeSource,
      load,
      variants: [],
    };
    parts.push(decision);
    partByCode.set(r.code, decision);
  }

  // ── Route steps ─────────────────────────────────────────────────────────
  const stepsByPart = new Map<string, Map<string, Array<{ step: NormalStep; ok: boolean }>>>();
  const seenKey = new Set<string>();
  for (const r of wb.steps) {
    const part = partByCode.get(r.partCode);
    const at = (code: IssueCode, severity: Severity, message: string, meta?: Record<string, unknown>) =>
      add(code, severity, "Part Routes", r.row, message, { partCode: r.partCode, meta });
    if (!part) {
      at("UNKNOWN_PART", "ERROR", `Route step for part ${r.partCode}, which is not in the Parts Master.`);
      continue;
    }
    let ok = true;
    const bad = (code: IssueCode, message: string, meta?: Record<string, unknown>) => {
      ok = false;
      at(code, "ERROR", message, meta);
    };
    const variant = r.variant === "" ? "A" : r.variant;
    if (!/^[A-Z]$/.test(variant)) bad("INVALID_VALUE", `Variant "${r.variant}" must be a single capital letter.`, { field: "variant" });
    const seq = intOrNull(r.seq);
    if (seq == null || seq <= 0) bad("INVALID_VALUE", `Step number "${r.seq}" must be a positive whole number.`, { field: "seq" });
    const dupKey = `${r.partCode}|${variant}|${seq}`;
    if (seq != null && seenKey.has(dupKey)) bad("DUPLICATE_STEP", `Part ${r.partCode} variant ${variant} has step ${seq} more than once.`, { variant, seq });
    seenKey.add(dupKey);

    const operationCode = OPERATIONS[r.operation] ?? null;
    if (!operationCode) bad("UNKNOWN_OPERATION", `Operation "${r.operation}" is not in the approved operation list.`, { operation: r.operation });

    const pvStage = r.pvStage === "" ? null : intOrNull(r.pvStage);
    const heStage = r.heStage === "" ? null : intOrNull(r.heStage);
    if ((r.pvStage !== "" && pvStage == null) || (r.heStage !== "" && heStage == null)) bad("INVALID_VALUE", `Stage numbers must be whole numbers (PV "${r.pvStage}", HE "${r.heStage}").`, { field: "stage" });

    let stdTime: number | null = null;
    let unit: string | null = null;
    let basis: string | null = null;
    if (r.stdTime === "") {
      at("MISSING_STD_TIME", "WARNING", `Step ${r.seq} of ${r.partCode} has no standard time.`);
    } else {
      stdTime = decimalOrNull(r.stdTime);
      if (stdTime == null || stdTime > 99999.999) bad("INVALID_VALUE", `Standard time "${r.stdTime}" must be a number up to 99999.999.`, { field: "stdTime" });
      unit = TIME_UNIT[r.timeUnit] ?? null;
      if (!unit) bad("INVALID_VALUE", `Time unit "${r.timeUnit}" is not Hours or Days.`, { field: "timeUnit" });
      basis = TIME_BASIS[r.timeBasis] ?? null;
      if (!basis) bad("UNKNOWN_TIME_BASIS", `Time basis "${r.timeBasis}" is not recognised.`, { timeBasis: r.timeBasis });
      if (/proposed/i.test(r.remarks)) at("PROPOSED_STD_TIME", "WARNING", `Standard time for step ${r.seq} of ${r.partCode} is a proposed value, not validated.`);
    }

    for (const f of checkStep(
      {
        scope: part.scope,
        partCode: r.partCode,
        operationLabel: r.operation,
        operationCode,
        department: r.department,
        seqText: r.seq,
        pvStage,
        heStage,
        pvBlank: r.pvStage === "",
        heBlank: r.heStage === "",
      },
      ref,
      heNumbers,
    )) {
      if (f.severity === "ERROR") bad(f.code, f.message, f.meta);
      else at(f.code, f.severity, f.message, f.meta);
    }

    const normal: NormalStep = {
      row: r.row,
      seq: seq ?? 0,
      operationCode: operationCode ?? r.operation,
      whatIsDone: r.whatIsDone,
      department: r.department,
      pvStage,
      heStage,
      stdTime,
      stdTimeUnit: unit,
      stdTimeBasis: basis,
      conditional: yes(r.conditional),
      conditionText: r.condition,
      acceptanceStandard: r.acceptance,
      recordDocument: r.record,
      requiresQc: true,
    };
    const byVariant = stepsByPart.get(r.partCode) ?? new Map();
    const list = byVariant.get(variant) ?? [];
    list.push({ step: normal, ok });
    byVariant.set(variant, list);
    stepsByPart.set(r.partCode, byVariant);
  }

  // ── Per-part: variants, fill-down, no-route ─────────────────────────────
  for (const part of parts) {
    const byVariant = stepsByPart.get(part.code);
    const at = (code: IssueCode, severity: Severity, message: string, meta?: Record<string, unknown>, row: number = part.row) =>
      add(code, severity, "Part Routes", row, message, { partCode: part.code, meta });
    const declared = (wb.parts.find((p) => p.code === part.code)?.variants ?? []).sort();
    if (!byVariant) {
      const bought = part.makeBuy === "BOUGHT_OUT";
      add("PART_WITHOUT_ROUTE", bought ? "INFO" : "WARNING", "Parts Master", part.row, `${part.code} has no route steps${bought ? " (bought-out item)" : ""}.`, { partCode: part.code, meta: { makeBuy: part.makeBuy } });
      continue;
    }
    const present = [...byVariant.keys()].sort();
    const contiguous = present.every((v, i) => v.charCodeAt(0) === "A".charCodeAt(0) + i);
    if (!contiguous || (declared.length > 0 && declared.join() !== present.join())) {
      at("VARIANT_GAP", "WARNING", `${part.code}: variants declared [${declared.join(", ") || "none"}] but steps exist for [${present.join(", ")}].`, { declared, present });
    }
    for (const variant of present) {
      const list = byVariant.get(variant)!;
      const steps = list.map((x) => x.step).sort((a, b) => a.seq - b.seq);
      part.variants.push({ variant, steps, load: part.load && list.every((x) => x.ok) });
      const pick = (op: string) => steps.filter((s) => s.operationCode === op);
      const [fit, weld, insp] = [pick("FIT_UP"), pick("WELDING"), pick("INSPECTION")];
      if (fit.length && weld.length && insp.length && fit.every((s) => s.pvStage === 19) && weld.every((s) => s.pvStage === 20) && insp.every((s) => s.pvStage === 21)) {
        at("POSSIBLE_FILL_DOWN", "WARNING", `${part.code} variant ${variant}: Fit-up → 19, Welding → 20, Inspection → 21 for every step. This looks like a fill-down, not a per-part decision.`, { variant, stages: [19, 20, 21] }, steps[0].row);
      }
    }
  }

  // ── Materials ───────────────────────────────────────────────────────────
  const materials: MaterialDecision[] = [];
  const seenMat = new Set<string>();
  for (const r of wb.materials) {
    const at = (code: IssueCode, severity: Severity, message: string, meta?: Record<string, unknown>) =>
      add(code, severity, "Material Master", r.row, message, { meta });
    const key = [r.spec, r.grade, r.productForm].map((x) => x.toLowerCase()).join("|");
    if (seenMat.has(key)) {
      at("DUPLICATE_MATERIAL", "ERROR", `${r.spec} ${r.grade} (${r.productForm}) appears more than once.`);
      continue;
    }
    seenMat.add(key);
    let load = true;
    let density: number | null = null;
    if (r.density === "") at("MISSING_DENSITY", "WARNING", `${r.spec} ${r.grade} (${r.productForm}) has no density.`);
    else {
      density = decimalOrNull(r.density);
      if (density == null || density <= 0 || density > 999.999) {
        at("INVALID_VALUE", "ERROR", `Density "${r.density}" must be a number above zero, up to 999.999.`, { field: "density" });
        load = false;
      }
    }
    materials.push({ row: r.row, spec: r.spec, grade: r.grade, productForm: r.productForm, densityGcc: density, remarks: r.remarks, load });
  }

  // ── Report-only sheets ──────────────────────────────────────────────────
  for (const r of wb.assembly) {
    for (const token of new Set(r.partsUsed.match(/\b[A-Z]{2,4}-\d{2}\b/g) ?? [])) {
      if (!partByCode.has(token)) add("ASSEMBLY_UNKNOWN_PART", "WARNING", "Assembly Sequence", r.row, `Assembly step "${r.activity}" uses ${token}, which is not in the Parts Master.`, { meta: { partCode: token } });
    }
  }
  for (const r of wb.newOperations) {
    add("NEW_OPERATION_PENDING", "INFO", "New Operations", r.row, `Proposed operation "${r.name}" (used in ${r.usedIn || "—"}) needs a decision; none are added in v1 (D16).`);
  }
  for (const r of wb.reviewActions) {
    if (/^open$/i.test(r.status)) add("REVIEW_ACTION_OPEN", "INFO", "Review Actions", r.row, `${r.id}: ${r.issue}`, { meta: { owner: r.owner, category: r.category } });
  }

  return { issues, parts, materials, heStages, heLoadable: heStages.length > 0 && heErrors === 0 };
}
