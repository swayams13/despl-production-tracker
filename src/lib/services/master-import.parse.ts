import * as XLSX from "xlsx";

/**
 * Lean Core M2 — reads the Standard Parts Master workbook into typed rows.
 * Pure: bytes in, rows out, no DB. Headers are found by NAME (normalised
 * prefix match), never by column position, so a team that inserts a column
 * does not silently shift data. Every row keeps its Excel row number so an
 * issue can point at the cell the team has to fix.
 *
 * Rows tagged EXAMPLE… in the "Example?" column are the workbook's grey
 * example rows and are skipped (counted in `skippedExamples`).
 */

export type Severity = "ERROR" | "WARNING" | "INFO";

export interface ParseProblem {
  sheet: string;
  row: number | null;
  code: "SHEET_MISSING" | "COLUMN_MISSING";
  message: string;
}

export interface PartRow {
  row: number;
  code: string;
  name: string;
  equipment: string;
  assemblyGroup: string;
  makeBuy: string;
  rawForm: string;
  typicalMoc: string;
  dimensions: string;
  weightBasis: string;
  variants: string[];
  spare: string;
  routeSource: string;
  filledBy: string;
  checkedBy: string;
  status: string;
  remarks: string;
}

export interface StepRow {
  row: number;
  partCode: string;
  variant: string;
  seq: string;
  operation: string;
  whatIsDone: string;
  department: string;
  pvStage: string;
  heStage: string;
  stdTime: string;
  timeUnit: string;
  timeBasis: string;
  conditional: string;
  condition: string;
  acceptance: string;
  record: string;
  remarks: string;
}

export interface MaterialRow {
  row: number;
  spec: string;
  grade: string;
  productForm: string;
  density: string;
  remarks: string;
  example: string;
}

export interface HeStageRow {
  row: number;
  heType: string;
  stageNo: string;
  name: string;
  activities: string;
  department: string;
  minDays: string;
  maxDays: string;
  predecessors: string;
  linkType: string;
  lag: string;
  optional: string;
  optionalWhen: string;
  remarks: string;
}

export interface StageRefRow {
  row: number;
  stageNo: string;
  name: string;
  department: string;
}

export interface AssemblyRow {
  row: number;
  equipmentType: string;
  groupCode: string;
  stepNo: string;
  activity: string;
  partsUsed: string;
  jointRef: string;
  department: string;
  stage: string;
}

export interface NewOperationRow {
  row: number;
  name: string;
  usedIn: string;
  department: string;
  why: string;
}

export interface ReviewActionRow {
  row: number;
  id: string;
  category: string;
  issue: string;
  owner: string;
  status: string;
}

export interface ParsedWorkbook {
  sheets: string[];
  parts: PartRow[];
  steps: StepRow[];
  materials: MaterialRow[];
  heStages: HeStageRow[];
  pvStagesRef: StageRefRow[];
  assembly: AssemblyRow[];
  newOperations: NewOperationRow[];
  reviewActions: ReviewActionRow[];
  skippedExamples: Record<string, number>;
  problems: ParseProblem[];
}

const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
const norm = (v: unknown): string => clean(v).toLowerCase();

type Spec = Record<string, string>; // field -> normalised header prefix

interface Sheet<T> {
  name: string;
  /** Fields that must exist for the sheet to be readable at all. */
  required: string[];
  spec: Spec;
  /** A row with this field blank is padding and is dropped. */
  keyField: string;
  build: (r: Record<string, string>, row: number) => T;
}

function readSheet<T>(wb: XLSX.WorkBook, def: Sheet<T>, out: ParsedWorkbook): T[] {
  const ws = wb.Sheets[def.name];
  if (!ws) {
    out.problems.push({ sheet: def.name, row: null, code: "SHEET_MISSING", message: `Sheet "${def.name}" is missing.` });
    return [];
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", blankrows: true });
  const firstRow = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]).s.r : 0;
  const headerIdx = grid.findIndex((r, i) => {
    if (i > 15) return false;
    const cells = r.map(norm);
    return def.required.every((f) => cells.some((c) => c.startsWith(def.spec[f])));
  });
  if (headerIdx < 0) {
    const cells = grid.slice(0, 8).flat().map(norm);
    const missing = def.required.filter((f) => !cells.some((c) => c.startsWith(def.spec[f])));
    out.problems.push({
      sheet: def.name,
      row: null,
      code: "COLUMN_MISSING",
      message: `Sheet "${def.name}": could not find the header row (missing column${missing.length === 1 ? "" : "s"}: ${missing.map((f) => `"${def.spec[f]}"`).join(", ")}).`,
    });
    return [];
  }
  const headers = grid[headerIdx].map(norm);
  const colOf: Record<string, number> = {};
  for (const [field, prefix] of Object.entries(def.spec)) colOf[field] = headers.findIndex((h) => h.startsWith(prefix));

  const rows: T[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r: Record<string, string> = {};
    for (const [field, idx] of Object.entries(colOf)) r[field] = idx >= 0 ? clean(grid[i][idx]) : "";
    if (!r[def.keyField]) continue;
    if (/^example/i.test(r.example ?? "")) {
      out.skippedExamples[def.name] = (out.skippedExamples[def.name] ?? 0) + 1;
      continue;
    }
    rows.push(def.build(r, firstRow + i + 1));
  }
  return rows;
}

const PARTS: Sheet<PartRow> = {
  name: "Parts Master",
  required: ["code", "name", "equipment", "status"],
  keyField: "code",
  spec: {
    example: "example?",
    code: "part code",
    name: "part name",
    equipment: "equipment",
    assemblyGroup: "assembly group",
    makeBuy: "make / buy",
    rawForm: "raw material form",
    typicalMoc: "typical moc",
    dimensions: "dimensions to enter",
    weightBasis: "weight basis",
    variants: "route variants",
    spare: "also a spare",
    routeSource: "route source",
    filledBy: "filled by",
    checkedBy: "checked by",
    status: "status",
    remarks: "remarks",
  },
  build: (r, row) => ({
    row,
    code: r.code,
    name: r.name,
    equipment: r.equipment,
    assemblyGroup: r.assemblyGroup,
    makeBuy: r.makeBuy,
    rawForm: r.rawForm,
    typicalMoc: r.typicalMoc,
    dimensions: r.dimensions,
    weightBasis: r.weightBasis,
    variants: r.variants.split(/[\s,;/]+/).filter(Boolean),
    spare: r.spare,
    routeSource: r.routeSource,
    filledBy: r.filledBy,
    checkedBy: r.checkedBy,
    status: r.status,
    remarks: r.remarks,
  }),
};

const STEPS: Sheet<StepRow> = {
  name: "Part Routes",
  required: ["code", "variant", "seq", "operation"],
  keyField: "code",
  spec: {
    example: "example?",
    code: "part code",
    variant: "variant",
    seq: "seq",
    operation: "operation",
    whatIsDone: "what is done",
    department: "department",
    pvStage: "counts toward pv stage",
    heStage: "counts toward he stage",
    stdTime: "std. time",
    timeUnit: "time unit",
    timeBasis: "time basis",
    conditional: "conditional?",
    condition: "when does it apply",
    acceptance: "acceptance standard",
    record: "record / document",
    remarks: "remarks",
  },
  build: (r, row) => ({
    row,
    partCode: r.code,
    variant: r.variant,
    seq: r.seq,
    operation: r.operation,
    whatIsDone: r.whatIsDone,
    department: r.department,
    pvStage: r.pvStage,
    heStage: r.heStage,
    stdTime: r.stdTime,
    timeUnit: r.timeUnit,
    timeBasis: r.timeBasis,
    conditional: r.conditional,
    condition: r.condition,
    acceptance: r.acceptance,
    record: r.record,
    remarks: r.remarks,
  }),
};

const MATERIALS: Sheet<MaterialRow> = {
  name: "Material Master",
  required: ["spec", "form"],
  keyField: "spec",
  spec: {
    example: "example?",
    spec: "material specification",
    grade: "grade / uns",
    form: "product form",
    density: "density",
    remarks: "remarks",
  },
  build: (r, row) => ({
    row,
    spec: r.spec,
    grade: r.grade,
    productForm: r.form,
    density: r.density,
    remarks: r.remarks,
    example: r.example,
  }),
};

const HE_STAGES: Sheet<HeStageRow> = {
  name: "HE Stages",
  required: ["stageNo", "name"],
  keyField: "stageNo",
  spec: {
    example: "example?",
    heType: "he type",
    stageNo: "stage no",
    name: "stage name",
    activities: "main activities",
    department: "department",
    minDays: "duration min",
    maxDays: "duration max",
    predecessors: "predecessor stage",
    linkType: "link type",
    lag: "lag / overlap",
    optional: "optional?",
    optionalWhen: "when is it optional",
    remarks: "remarks",
  },
  build: (r, row) => ({
    row,
    heType: r.heType,
    stageNo: r.stageNo,
    name: r.name,
    activities: r.activities,
    department: r.department,
    minDays: r.minDays,
    maxDays: r.maxDays,
    predecessors: r.predecessors,
    linkType: r.linkType,
    lag: r.lag,
    optional: r.optional,
    optionalWhen: r.optionalWhen,
    remarks: r.remarks,
  }),
};

const PV_REF: Sheet<StageRefRow> = {
  name: "PV Stages (ref)",
  required: ["stageNo", "name"],
  keyField: "stageNo",
  spec: { stageNo: "stage no", name: "stage name", department: "department" },
  build: (r, row) => ({ row, stageNo: r.stageNo, name: r.name, department: r.department }),
};

const ASSEMBLY: Sheet<AssemblyRow> = {
  name: "Assembly Sequence",
  required: ["equipmentType", "activity"],
  keyField: "activity",
  spec: {
    example: "example?",
    equipmentType: "equipment type",
    groupCode: "group code",
    stepNo: "step no",
    activity: "activity",
    partsUsed: "parts / sub-assemblies used",
    jointRef: "weld joint ref",
    department: "department",
    stage: "counts toward stage no",
  },
  build: (r, row) => ({
    row,
    equipmentType: r.equipmentType,
    groupCode: r.groupCode,
    stepNo: r.stepNo,
    activity: r.activity,
    partsUsed: r.partsUsed,
    jointRef: r.jointRef,
    department: r.department,
    stage: r.stage,
  }),
};

const NEW_OPS: Sheet<NewOperationRow> = {
  name: "New Operations",
  required: ["name"],
  keyField: "name",
  spec: { example: "example?", name: "proposed operation", usedIn: "used in", department: "department", why: "why the existing" },
  build: (r, row) => ({ row, name: r.name, usedIn: r.usedIn, department: r.department, why: r.why }),
};

const REVIEW: Sheet<ReviewActionRow> = {
  name: "Review Actions",
  required: ["id", "issue"],
  keyField: "id",
  spec: { id: "id", category: "category", issue: "issue or decision", owner: "owner", status: "status" },
  build: (r, row) => ({ row, id: r.id, category: r.category, issue: r.issue, owner: r.owner, status: r.status }),
};

export function parseMasterWorkbook(bytes: Buffer | Uint8Array): ParsedWorkbook {
  const wb = XLSX.read(bytes, { type: "buffer" });
  const out: ParsedWorkbook = {
    sheets: wb.SheetNames,
    parts: [],
    steps: [],
    materials: [],
    heStages: [],
    pvStagesRef: [],
    assembly: [],
    newOperations: [],
    reviewActions: [],
    skippedExamples: {},
    problems: [],
  };
  out.parts = readSheet(wb, PARTS, out);
  out.steps = readSheet(wb, STEPS, out);
  out.materials = readSheet(wb, MATERIALS, out);
  out.heStages = readSheet(wb, HE_STAGES, out);
  out.pvStagesRef = readSheet(wb, PV_REF, out);
  out.assembly = readSheet(wb, ASSEMBLY, out);
  out.newOperations = readSheet(wb, NEW_OPS, out);
  out.reviewActions = readSheet(wb, REVIEW, out);
  return out;
}
