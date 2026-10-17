/**
 * Lean Core L2.10 (part A): DESPL's live-job tracker sheet (the DE0463 / DE0467
 * format) read into typed rows, and turned into a plan of writes. Pure: a grid
 * of cells in, a parsed tracker or a plan out. No xlsx, no database.
 *
 * The sheet is ONE worksheet: a title block, a two-row header (group row, then
 * column names), item rows in blocks (numbering restarts at 1 for each block;
 * the block label cells were merged and are usually empty), then an "ASSEMBLY
 * DRAWINGS" section and an "ASSEMBLY PROCESSES" section. Columns are found by
 * header text, never by position.
 *
 * What part A writes: equipment per block, BOM items, procurement events. The
 * manufacturing and test columns, the material identification, the drawings and
 * the assembly processes are READ and COUNTED but not written: they need
 * components and routes (J5). Re-uploading the same file after J5 loads them.
 */

/** A cell as the reader hands it over: a real Excel date arrives as `{ iso }`. */
export type Cell = string | number | boolean | null | { iso: string };

export type Severity = "ERROR" | "WARNING" | "INFO";

export type IssueCode =
  | "HEADER_NOT_FOUND"
  | "UNKNOWN_COLUMN"
  | "JOB_NUMBER_MISMATCH"
  | "UNLABELLED_BLOCK"
  | "AMBIGUOUS_DATE"
  | "DATE_UNREADABLE"
  | "PART_NAME_MISSING"
  | "QTY_MISSING"
  | "ITEM_EXISTS"
  | "ITEM_CONFLICT"
  | "RECEIVED_WITHOUT_DATE"
  | "INDENT_WITHOUT_DATE"
  | "PO_WITHOUT_DATE"
  | "NOT_IMPORTED";

export interface Issue {
  severity: Severity;
  code: IssueCode;
  /** 1-based Excel row, null when the issue is about the file as a whole. */
  row: number | null;
  message: string;
}

export interface TrackerProcurement {
  indentNo: string | null;
  indentGenerateDate: string | null;
  indentApprovedDate: string | null;
  status: string | null;
  poNo: string | null;
  poDate: string | null;
  receivedStatus: string | null;
  receivedDate: string | null;
}

export interface TrackerStep {
  /** "Cutting", "RT", … as the sheet names it. */
  name: string;
  type: string | null;
  start: string | null;
  end: string | null;
  result: string | null;
}

export interface TrackerItem {
  row: number;
  itemNo: number;
  partName: string;
  description: string | null;
  material: string | null;
  /** Verbatim ("40", "1"), never guessed when empty. */
  qty: string | null;
  unit: string | null;
  procurement: TrackerProcurement;
  materialIdentification: { kind: string | null; date: string | null };
  /** Manufacturing processes and tests that carry any value. */
  steps: TrackerStep[];
  overallStatus: string | null;
  remarks: string | null;
}

export interface TrackerBlock {
  /** 1-based, in order of appearance. */
  blockNo: number;
  /** The label cell above the block when the sheet kept one. */
  label: string | null;
  firstRow: number;
  items: TrackerItem[];
}

export interface TrackerHeader {
  workOrderNo: string | null;
  orderDateText: string | null;
  projectName: string | null;
  dispatchDateText: string | null;
  qtyText: string | null;
}

export interface TrackerNamed {
  row: number;
  name: string;
  /** Drawing no. or process type. */
  ref: string | null;
  dates: string[];
}

export interface ParsedTracker {
  header: TrackerHeader;
  blocks: TrackerBlock[];
  drawings: TrackerNamed[];
  assemblyProcesses: TrackerNamed[];
  issues: Issue[];
}

const text = (c: Cell | undefined): string | null => {
  if (c == null || typeof c === "boolean") return null;
  const s = typeof c === "object" ? c.iso : String(c);
  const t = s.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};
const norm = (c: Cell | undefined) => (text(c) ?? "").toLowerCase();

const MAX_ISSUES_PER_CODE = 25;

/**
 * A date cell to "YYYY-MM-DD". A real Excel date is exact. Text is read day
 * first (C11); a "/" date whose two numbers are both 12 or less could be read
 * either way, so it is flagged and read day first.
 */
export function readDate(c: Cell | undefined, row: number, what: string, issues: Issue[]): string | null {
  if (c == null || c === "") return null;
  if (typeof c === "object") return c.iso;
  const s = text(c);
  if (!s) return null;
  const m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})$/.exec(s) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    issues.push({ severity: "WARNING", code: "DATE_UNREADABLE", row, message: `${what}: "${s}" is not a date this importer can read, so it was left out.` });
    return null;
  }
  let d: number, mo: number, y: number;
  if (m.length === 4) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    const a = Number(m[1]);
    const b = Number(m[3]);
    y = Number(m[4]);
    if (y < 100) y += 2000;
    if (m[2] === "/" && a <= 12 && b <= 12 && a !== b) {
      issues.push({ severity: "WARNING", code: "AMBIGUOUS_DATE", row, message: `${what}: "${s}" could be day/month or month/day. Read as day/month (${String(a).padStart(2, "0")} ${String(b).padStart(2, "0")}).` });
    }
    if (m[2] === "/" && b > 12 && a <= 12) {
      [mo, d] = [a, b];
    } else {
      [d, mo] = [a, b];
    }
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    issues.push({ severity: "WARNING", code: "DATE_UNREADABLE", row, message: `${what}: "${s}" is not a real date, so it was left out.` });
    return null;
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

type Field =
  | "itemNo" | "partName" | "description" | "material" | "qty" | "unit"
  | "indentNo" | "indentGenerateDate" | "indentApprovedDate" | "procStatus" | "poNo" | "poDate" | "receivedStatus" | "receivedDate"
  | "matId" | "matIdDate" | "overallStatus" | "remarks";

const FIELD_BY_HEADER: Record<string, Field> = {
  "item no.": "itemNo", "item no": "itemNo",
  "part name": "partName", description: "description", material: "material", qty: "qty", unit: "unit",
  "indent no.": "indentNo", "indent no": "indentNo",
  "indent generate date": "indentGenerateDate", "indent approved date": "indentApprovedDate",
  "procurement status": "procStatus", "po no.": "poNo", "po no": "poNo", "po date": "poDate",
  "material received status": "receivedStatus", "material received date": "receivedDate",
  "material identification": "matId", "material identification date": "matIdDate",
  "overall status": "overallStatus", remarks: "remarks",
};

const STEP_HEADER = /^(.+?) (type|start|end|result)$/;

interface Columns {
  field: Partial<Record<Field, number>>;
  /** step name -> part -> column */
  steps: Map<string, Partial<Record<"type" | "start" | "end" | "result", number>>>;
}

function mapColumns(header: Cell[], issues: Issue[], headerRow: number): Columns {
  const cols: Columns = { field: {}, steps: new Map() };
  const unknown: string[] = [];
  header.forEach((c, i) => {
    const h = norm(c);
    if (!h) return;
    const f = FIELD_BY_HEADER[h];
    if (f) {
      if (cols.field[f] === undefined) cols.field[f] = i;
      return;
    }
    const s = STEP_HEADER.exec(h);
    if (s) {
      const name = text(header[i])!.replace(/\s+(type|start|end|result)$/i, "");
      const entry = cols.steps.get(name) ?? {};
      entry[s[2] as "type"] = i;
      cols.steps.set(name, entry);
      return;
    }
    unknown.push(text(c)!);
  });
  if (unknown.length) {
    issues.push({ severity: "INFO", code: "UNKNOWN_COLUMN", row: headerRow, message: `Columns this importer does not read: ${unknown.join(", ")}.` });
  }
  return cols;
}

function readHeaderBlock(grid: Cell[][], upTo: number): TrackerHeader {
  const h: TrackerHeader = { workOrderNo: null, orderDateText: null, projectName: null, dispatchDateText: null, qtyText: null };
  for (let r = 0; r < upTo; r++) {
    (grid[r] ?? []).forEach((c, i) => {
      const l = norm(c);
      const below = text(grid[r + 1]?.[i]);
      if (l.startsWith("work order no")) h.workOrderNo = below;
      else if (l.startsWith("order generate date")) h.orderDateText = below;
      else if (l.startsWith("project name")) h.projectName = below;
      else if (l.startsWith("dispatch date")) {
        h.dispatchDateText = below;
        const q = text(grid[r]?.[i + 1]);
        if (q && /^qty/i.test(q)) h.qtyText = q;
      }
    });
  }
  return h;
}

/** Part of the sheet below the items: drawings and assembly processes. */
function readNamedSection(grid: Cell[][], start: number, stop: (r: number) => boolean, lastDateCol: number, issues: Issue[], what: string): TrackerNamed[] {
  const out: TrackerNamed[] = [];
  // start = the marker row; the next non-empty row is the column header, skip it.
  let r = start + 1;
  while (r < grid.length && !grid[r].some((c) => text(c))) r++;
  r++;
  for (; r < grid.length && !stop(r); r++) {
    const row = grid[r];
    const name = text(row[0]);
    if (!name) continue;
    const dates: string[] = [];
    for (let c = 2; c <= Math.min(row.length - 1, lastDateCol); c++) {
      const d = row[c] == null || row[c] === "" ? null : readDate(row[c], r + 1, `${what} "${name}"`, issues);
      if (d) dates.push(d);
    }
    out.push({ row: r + 1, name, ref: text(row[1]), dates });
  }
  return out;
}

export function parseTrackerGrid(grid: Cell[][]): ParsedTracker {
  const issues: Issue[] = [];
  const empty: ParsedTracker = {
    header: { workOrderNo: null, orderDateText: null, projectName: null, dispatchDateText: null, qtyText: null },
    blocks: [], drawings: [], assemblyProcesses: [], issues,
  };
  const headerIdx = grid.findIndex((r, i) => i < 30 && /^item no\.?$/.test(norm(r[0])));
  if (headerIdx < 0) {
    issues.push({ severity: "ERROR", code: "HEADER_NOT_FOUND", row: null, message: 'This does not look like a DESPL tracker: no header row starting with "Item No." was found in the first 30 rows.' });
    return empty;
  }
  const cols = mapColumns(grid[headerIdx], issues, headerIdx + 1);
  for (const need of ["partName", "qty"] as const) {
    if (cols.field[need] === undefined) {
      issues.push({ severity: "ERROR", code: "HEADER_NOT_FOUND", row: headerIdx + 1, message: `The header row has no "${need === "partName" ? "Part Name" : "Qty"}" column.` });
      return { ...empty, header: readHeaderBlock(grid, headerIdx) };
    }
  }
  const header = readHeaderBlock(grid, headerIdx);

  const get = (row: Cell[], f: Field): Cell | undefined => (cols.field[f] === undefined ? undefined : row[cols.field[f]!]);
  const blocks: TrackerBlock[] = [];
  let cur: TrackerBlock | null = null;
  let pendingLabel: string | null = null;
  let last = 0;
  let drawingsAt = -1;
  let processesAt = -1;

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    const a = norm(row[0]);
    if (a.startsWith("assembly drawings")) { drawingsAt = r; continue; }
    if (a.startsWith("assembly processes")) { processesAt = r; break; }
    if (drawingsAt >= 0) continue;
    if (!row.some((c) => text(c))) continue;

    const noText = text(row[0]);
    const itemNo = noText && /^\d+$/.test(noText) ? Number(noText) : null;
    if (itemNo === null) {
      // A lone text cell above the items is a block label.
      if (noText && row.slice(1).every((c) => !text(c))) pendingLabel = noText;
      continue;
    }
    if (!cur || itemNo <= last) {
      cur = { blockNo: blocks.length + 1, label: pendingLabel, firstRow: r + 1, items: [] };
      blocks.push(cur);
      pendingLabel = null;
    }
    last = itemNo;

    const partName = text(get(row, "partName"));
    const iss = (severity: Severity, code: IssueCode, message: string) => issues.push({ severity, code, row: r + 1, message });
    const rowIssues: Issue[] = [];
    const date = (f: Field, what: string) => readDate(get(row, f), r + 1, what, rowIssues);
    const steps: TrackerStep[] = [];
    for (const [name, c] of cols.steps) {
      const step: TrackerStep = {
        name,
        type: text(c.type === undefined ? undefined : row[c.type]),
        start: c.start === undefined || row[c.start] == null ? null : readDate(row[c.start], r + 1, `${name} start`, rowIssues),
        end: c.end === undefined || row[c.end] == null ? null : readDate(row[c.end], r + 1, `${name} end`, rowIssues),
        result: text(c.result === undefined ? undefined : row[c.result]),
      };
      if (step.start || step.end || step.result || step.type) steps.push(step);
    }
    const item: TrackerItem = {
      row: r + 1,
      itemNo,
      partName: partName ?? "",
      description: text(get(row, "description")),
      material: text(get(row, "material")),
      qty: text(get(row, "qty")),
      unit: text(get(row, "unit")),
      procurement: {
        indentNo: text(get(row, "indentNo")),
        indentGenerateDate: date("indentGenerateDate", "Indent generate date"),
        indentApprovedDate: date("indentApprovedDate", "Indent approved date"),
        status: text(get(row, "procStatus")),
        poNo: text(get(row, "poNo")),
        poDate: date("poDate", "PO date"),
        receivedStatus: text(get(row, "receivedStatus")),
        receivedDate: date("receivedDate", "Material received date"),
      },
      materialIdentification: { kind: text(get(row, "matId")), date: date("matIdDate", "Material identification date") },
      steps,
      overallStatus: text(get(row, "overallStatus")),
      remarks: text(get(row, "remarks")),
    };
    issues.push(...rowIssues);
    if (!partName) iss("ERROR", "PART_NAME_MISSING", `Item ${itemNo} has no part name, so it is not loaded.`);
    else if (!item.qty) iss("ERROR", "QTY_MISSING", `Item ${itemNo} (${partName}) has no quantity, so it is not loaded. Add the quantity in Excel and check the file again.`);
    cur.items.push(item);
  }

  for (const b of blocks) {
    if (!b.label) {
      issues.push({
        severity: "INFO", code: "UNLABELLED_BLOCK", row: b.firstRow,
        message: `Block ${b.blockNo} (${b.items.length} item${b.items.length === 1 ? "" : "s"}, from row ${b.firstRow}) has no label in the sheet. Say which equipment it is.`,
      });
    }
  }

  const drawings = drawingsAt >= 0
    ? readNamedSection(grid, drawingsAt, (r) => processesAt >= 0 && r >= processesAt, 4, issues, "Drawing")
    : [];
  const assemblyProcesses = processesAt >= 0 ? readNamedSection(grid, processesAt, () => false, 3, issues, "Assembly process") : [];

  return { header, blocks, drawings: drawings.filter((d) => d.ref || d.dates.length), assemblyProcesses: assemblyProcesses.filter((p) => p.ref || p.dates.length), issues: capIssues(issues) };
}

/** A sheet with a thousand ambiguous dates must not drown the report: keep the first few of each code and say how many more. */
export function capIssues(issues: Issue[]): Issue[] {
  const seen = new Map<string, number>();
  const out: Issue[] = [];
  const over = new Map<string, { sample: Issue; n: number }>();
  for (const i of issues) {
    const key = `${i.severity}:${i.code}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n <= MAX_ISSUES_PER_CODE) out.push(i);
    else {
      const o = over.get(key) ?? { sample: i, n: 0 };
      o.n++;
      over.set(key, o);
    }
  }
  for (const { sample, n } of over.values()) {
    out.push({ severity: sample.severity, code: sample.code, row: null, message: `…and ${n} more like this (${sample.code.toLowerCase().replace(/_/g, " ")}).` });
  }
  return out;
}

/* ── The plan ─────────────────────────────────────────────────────────── */

export type ProcurementType = "INDENT_RAISED" | "INDENT_APPROVED" | "PO_PLACED" | "RECEIPT";

export interface PlannedEvent {
  type: ProcurementType;
  /** "YYYY-MM-DD" */
  on: string;
  refNo: string | null;
  qty: number | null;
}

/** Where a block goes: an existing equipment of the job, or a new one with this name. */
export type BlockTarget = { equipmentId: number } | { newName: string };

export interface PlannedItem {
  blockNo: number;
  row: number;
  itemNo: number;
  target: BlockTarget;
  action: "CREATE" | "SKIP_EXISTS" | "SKIP_CONFLICT" | "SKIP_ERROR";
  data: {
    partName: string;
    description: string | null;
    material: string | null;
    sourceQty: string;
    qtyPer: number | null;
    unit: string | null;
    remarks: string | null;
  };
  events: PlannedEvent[];
}

export interface ImportPlan {
  items: PlannedItem[];
  newEquipment: Array<{ blockNo: number; name: string }>;
  counts: {
    blocks: number;
    items: number;
    create: number;
    exists: number;
    conflict: number;
    errors: number;
    events: number;
  };
  /** Read from the sheet, shown, not written yet (needs J5). */
  carried: { itemsWithSteps: number; stepEntries: number; materialIdentifications: number; drawings: number; assemblyProcesses: number };
}

/** Existing BOM items of the target equipments, by equipment id then item no. */
export type ExistingBom = Map<number, Map<number, { partName: string }>>;

const sameName = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

export function eventsFor(item: TrackerItem, rowIssues: Issue[]): PlannedEvent[] {
  const p = item.procurement;
  const out: PlannedEvent[] = [];
  const row = item.row;
  if (p.indentGenerateDate) out.push({ type: "INDENT_RAISED", on: p.indentGenerateDate, refNo: p.indentNo, qty: null });
  else if (p.indentNo) rowIssues.push({ severity: "WARNING", code: "INDENT_WITHOUT_DATE", row, message: `Item ${item.itemNo}: indent ${p.indentNo} has no generate date, so no indent event is recorded.` });
  if (p.indentApprovedDate) out.push({ type: "INDENT_APPROVED", on: p.indentApprovedDate, refNo: null, qty: null });
  if (p.poDate) out.push({ type: "PO_PLACED", on: p.poDate, refNo: p.poNo, qty: null });
  else if (p.poNo) rowIssues.push({ severity: "WARNING", code: "PO_WITHOUT_DATE", row, message: `Item ${item.itemNo}: PO ${p.poNo} has no date, so no PO event is recorded.` });
  if (p.receivedDate) {
    const full = /^received$/i.test(p.receivedStatus ?? "");
    const q = item.qty && /^\d+(\.\d+)?$/.test(item.qty) ? Number(item.qty) : null;
    out.push({ type: "RECEIPT", on: p.receivedDate, refNo: null, qty: full ? q : null });
  } else if (/^(partially )?received$/i.test(p.receivedStatus ?? "")) {
    rowIssues.push({ severity: "WARNING", code: "RECEIVED_WITHOUT_DATE", row, message: `Item ${item.itemNo}: marked "${p.receivedStatus}" with no received date, so no receipt is recorded (a date is never made up).` });
  }
  return out;
}

const remarksOf = (i: TrackerItem): string | null => {
  const parts = [i.remarks, i.procurement.status ? `Tracker status: ${i.procurement.status}` : null].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : null;
};

export function buildImportPlan(
  parsed: ParsedTracker,
  targets: Map<number, BlockTarget>,
  existing: ExistingBom,
): { plan: ImportPlan; issues: Issue[] } {
  const issues: Issue[] = [];
  const items: PlannedItem[] = [];
  const newEquipment: ImportPlan["newEquipment"] = [];
  const seenNew = new Set<number>();
  let carriedItems = 0;
  let stepEntries = 0;
  let matIds = 0;

  for (const block of parsed.blocks) {
    const target = targets.get(block.blockNo);
    if (!target) continue;
    if ("newName" in target && !seenNew.has(block.blockNo)) {
      seenNew.add(block.blockNo);
      newEquipment.push({ blockNo: block.blockNo, name: target.newName });
    }
    const have = "equipmentId" in target ? existing.get(target.equipmentId) : undefined;
    for (const it of block.items) {
      if (it.steps.length) { carriedItems++; stepEntries += it.steps.length; }
      if (it.materialIdentification.kind || it.materialIdentification.date) matIds++;
      const bad = !it.partName || !it.qty;
      const prior = have?.get(it.itemNo);
      let action: PlannedItem["action"] = "CREATE";
      if (bad) action = "SKIP_ERROR";
      else if (prior) {
        if (sameName(prior.partName, it.partName)) {
          action = "SKIP_EXISTS";
        } else {
          action = "SKIP_CONFLICT";
          issues.push({ severity: "WARNING", code: "ITEM_CONFLICT", row: it.row, message: `Item ${it.itemNo} is "${it.partName}" in the sheet but "${prior.partName}" already in the job. Not loaded.` });
        }
      }
      const rowIssues: Issue[] = [];
      const events = action === "CREATE" ? eventsFor(it, rowIssues) : [];
      issues.push(...rowIssues);
      items.push({
        blockNo: block.blockNo,
        row: it.row,
        itemNo: it.itemNo,
        target,
        action,
        data: {
          partName: it.partName,
          description: it.description,
          material: it.material,
          sourceQty: it.qty ?? "",
          qtyPer: it.qty && /^\d+(\.\d+)?$/.test(it.qty) ? Number(it.qty) : null,
          unit: it.unit,
          remarks: remarksOf(it),
        },
        events,
      });
    }
  }
  const exists = items.filter((i) => i.action === "SKIP_EXISTS").length;
  if (exists) issues.push({ severity: "INFO", code: "ITEM_EXISTS", row: null, message: `${exists} item${exists === 1 ? " is" : "s are"} already in the job and will be left as they are.` });

  const plan: ImportPlan = {
    items,
    newEquipment,
    counts: {
      blocks: parsed.blocks.length,
      items: items.length,
      create: items.filter((i) => i.action === "CREATE").length,
      exists,
      conflict: items.filter((i) => i.action === "SKIP_CONFLICT").length,
      errors: items.filter((i) => i.action === "SKIP_ERROR").length,
      events: items.reduce((n, i) => n + i.events.length, 0),
    },
    carried: {
      itemsWithSteps: carriedItems,
      stepEntries,
      materialIdentifications: matIds,
      drawings: parsed.drawings.length,
      assemblyProcesses: parsed.assemblyProcesses.length,
    },
  };
  const c = plan.carried;
  if (c.stepEntries || c.materialIdentifications || c.drawings || c.assemblyProcesses) {
    issues.push({
      severity: "INFO",
      code: "NOT_IMPORTED",
      row: null,
      message:
        `Read but not loaded yet: ${c.stepEntries} manufacturing / test entr${c.stepEntries === 1 ? "y" : "ies"} on ${c.itemsWithSteps} item${c.itemsWithSteps === 1 ? "" : "s"}, ` +
        `${c.materialIdentifications} material identification${c.materialIdentifications === 1 ? "" : "s"}, ${c.drawings} drawing${c.drawings === 1 ? "" : "s"}, ` +
        `${c.assemblyProcesses} assembly process${c.assemblyProcesses === 1 ? "" : "es"}. They need components and routes; upload this file again once those exist.`,
    });
  }
  return { plan, issues };
}
