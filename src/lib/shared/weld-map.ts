import type { JointType } from "@/generated/prisma/client";
import type { Cell, Severity } from "./job-import";

/**
 * Lean Core J4b: a line's weld map. Pure: a grid of cells in, rows and a plan out.
 * No xlsx, no database.
 *
 * Default joint numbering (I7 is not supplied; QC / Welding to ratify):
 *   LS-n, CS-n   long and circumferential seams (generated from shell courses)
 *   NS-<tag>     nozzle to shell or head      NF-<tag>   nozzle to flange
 *   SK-n         skirt to head                BR-SK      base ring
 *   GW-n         gussets                      AT-n       other attachments
 * Columns are found by header text, never by position.
 */

export type WeldMapIssueCode =
  | "HEADER_NOT_FOUND"
  | "IGNORED_COLUMNS"
  | "JOINT_NO_MISSING"
  | "JOINT_NO_INVALID"
  | "JOINT_NO_DUPLICATE"
  | "TYPE_UNREADABLE"
  | "TYPE_PREFIX_MISMATCH"
  | "REMARKS_NOT_STORED"
  | "NO_ROWS";

export interface WeldMapIssue {
  severity: Severity;
  code: WeldMapIssueCode;
  /** 1-based Excel row, null for the file as a whole. */
  row: number | null;
  message: string;
}

export interface WeldMapRow {
  row: number;
  jointNo: string;
  jointType: JointType;
  /** False when the type was inferred from the joint number. */
  typeGiven: boolean;
  joins: string | null;
  wpsRef: string | null;
  ndtExtent: string | null;
}

export interface ParsedWeldMap {
  rows: WeldMapRow[];
  issues: WeldMapIssue[];
}

/** Joint type from the printed weld-map prefix (LS, CS, NS-/NF-/N<n>/M<n> nozzles, anything else an attachment). */
export function jointTypeFromNo(jointNo: string): JointType {
  const n = jointNo.trim().toUpperCase();
  if (n.startsWith("LS")) return "LONG_SEAM";
  if (n.startsWith("CS")) return "CIRC_SEAM";
  if (n.startsWith("NS") || n.startsWith("NF") || /^[NM]\d/.test(n)) return "NOZZLE";
  return "ATTACHMENT";
}

export const JOINT_TYPE_LABEL: Record<JointType, string> = {
  LONG_SEAM: "Long seam",
  CIRC_SEAM: "Circ seam",
  NOZZLE: "Nozzle",
  ATTACHMENT: "Attachment",
};

const JOINT_NO = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/;
export const normaliseJointNo = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase();

/** "Long seam", "LS", "circumferential", "Nozzle", "Attachment/skirt/gusset" ... to a JointType; null when unreadable. */
export function jointTypeFromText(text: string): JointType | null {
  const t = text.toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (t === "ls" || t.startsWith("long")) return "LONG_SEAM";
  if (t === "cs" || t.startsWith("circ")) return "CIRC_SEAM";
  if (t.startsWith("nozz") || t === "ns" || t === "nf" || t.startsWith("manway") || t.startsWith("manhole")) return "NOZZLE";
  if (/^(attach|other|skirt|gusset|lug|cleat|saddle|pad|base|support|leg|clip)/.test(t)) return "ATTACHMENT";
  return null;
}

type Col = "jointNo" | "type" | "joins" | "wps" | "ndt" | "remarks";
const ALIASES: Record<Col, string[]> = {
  jointNo: ["jointno", "joint", "jointnumber", "jointid", "jointref", "weldno", "weldjointno", "weldjoint", "jt", "jointnos"],
  type: ["type", "jointtype", "weldtype"],
  joins: ["joins", "joined", "componentsjoined", "jointdescription", "description", "whatitjoins", "connects"],
  wps: ["wps", "wpsno", "wpsref", "wpsnumber", "wpsrefno", "wpsreference"],
  ndt: ["ndt", "ndtextent", "extentofndt", "ndtpercent", "ndtrequired", "ndtscope"],
  remarks: ["remarks", "remark", "notes", "note", "comments", "comment"],
};
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function text(c: Cell | undefined): string {
  if (c == null) return "";
  if (typeof c === "string") return c.trim();
  if (typeof c === "number") return String(c);
  if (typeof c === "object") return c.iso;
  return "";
}

const HEADER_SEARCH_ROWS = 30;
export const MAX_WELD_MAP_JOINTS = 500;

export function parseWeldMapGrid(grid: Cell[][]): ParsedWeldMap {
  const issues: WeldMapIssue[] = [];
  let headerRow = -1;
  const col: Partial<Record<Col, number>> = {};
  for (let r = 0; r < Math.min(grid.length, HEADER_SEARCH_ROWS); r++) {
    const keys = grid[r].map((c) => key(text(c)));
    if (keys.some((k) => ALIASES.jointNo.includes(k))) {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) {
    return {
      rows: [],
      issues: [{ severity: "ERROR", code: "HEADER_NOT_FOUND", row: null, message: 'No "Joint no" column was found in the first 30 rows. The first row of the table should read: Joint no, Type, Joins, WPS, NDT extent, Remarks.' }],
    };
  }
  const ignored: string[] = [];
  grid[headerRow].forEach((c, i) => {
    const k = key(text(c));
    if (!k) return;
    const hit = (Object.keys(ALIASES) as Col[]).find((n) => ALIASES[n].includes(k));
    if (hit && col[hit] == null) col[hit] = i;
    else ignored.push(text(c));
  });
  if (ignored.length) {
    issues.push({ severity: "INFO", code: "IGNORED_COLUMNS", row: headerRow + 1, message: `Columns not read: ${ignored.join(", ")}.` });
  }

  const rows: WeldMapRow[] = [];
  const firstRow = new Map<string, number>();
  let remarksSeen = false;
  for (let r = headerRow + 1; r < grid.length; r++) {
    const line = grid[r];
    if (line.every((c) => text(c) === "")) continue;
    const at = (c: Col) => (col[c] == null ? "" : text(line[col[c]!]));
    const row = r + 1;
    if (at("remarks")) remarksSeen = true;
    const raw = at("jointNo");
    if (!raw) {
      issues.push({ severity: "ERROR", code: "JOINT_NO_MISSING", row, message: "This row has no joint number, so it is not loaded." });
      continue;
    }
    const jointNo = normaliseJointNo(raw);
    if (!JOINT_NO.test(jointNo)) {
      issues.push({ severity: "ERROR", code: "JOINT_NO_INVALID", row, message: `"${raw}" is not a joint number I can use. One joint per row, letters, digits and - . / _ only, no spaces (up to 40 characters).` });
      continue;
    }
    if (firstRow.has(jointNo)) {
      issues.push({ severity: "ERROR", code: "JOINT_NO_DUPLICATE", row, message: `${jointNo} is already on row ${firstRow.get(jointNo)}; this row is not loaded.` });
      continue;
    }
    firstRow.set(jointNo, row);

    const typeText = at("type");
    const inferred = jointTypeFromNo(jointNo);
    let jointType = inferred;
    let typeGiven = false;
    if (typeText) {
      const t = jointTypeFromText(typeText);
      if (!t) {
        issues.push({ severity: "ERROR", code: "TYPE_UNREADABLE", row, message: `${jointNo}: "${typeText}" is not a joint type. Use Long seam, Circ seam, Nozzle or Attachment, or leave it blank.` });
        continue;
      }
      jointType = t;
      typeGiven = true;
      if (t !== inferred && /^(LS|CS|NS|NF)/.test(jointNo)) {
        issues.push({ severity: "WARNING", code: "TYPE_PREFIX_MISMATCH", row, message: `${jointNo} is typed ${JOINT_TYPE_LABEL[t]}, but its number starts like a ${JOINT_TYPE_LABEL[inferred].toLowerCase()}. Check one of them.` });
      }
    }
    rows.push({ row, jointNo, jointType, typeGiven, joins: at("joins") || null, wpsRef: at("wps") || null, ndtExtent: at("ndt") || null });
  }
  if (remarksSeen) {
    issues.push({ severity: "INFO", code: "REMARKS_NOT_STORED", row: null, message: "The Remarks column is read but not stored; there is no place for it on a joint yet." });
  }
  if (rows.length === 0 && !issues.some((i) => i.severity === "ERROR")) {
    issues.push({ severity: "ERROR", code: "NO_ROWS", row: null, message: "The table has no joints under its header." });
  }
  if (rows.length > MAX_WELD_MAP_JOINTS) {
    issues.push({ severity: "ERROR", code: "NO_ROWS", row: null, message: `A weld map of more than ${MAX_WELD_MAP_JOINTS} joints is more than the importer takes; split the file.` });
    return { rows: [], issues };
  }
  return { rows, issues };
}

// ---------------------------------------------------------------- plan

export interface ExistingJoint {
  jointNo: string;
  jointType: JointType;
  joins: string | null;
  wpsRef: string | null;
  ndtExtent: string | null;
  confirmed: boolean;
  /** Weld records plus assembly steps that point at this joint. */
  used: number;
}
export type PlanAction = "ADD" | "UPDATE" | "SAME" | "REFUSED";
export interface FieldChange {
  field: "jointType" | "joins" | "wpsRef" | "ndtExtent";
  from: string | null;
  to: string | null;
}
export interface PlanRow {
  row: number;
  jointNo: string;
  jointType: JointType;
  joins: string | null;
  wpsRef: string | null;
  ndtExtent: string | null;
  action: PlanAction;
  changes: FieldChange[];
  /** True when an UPDATE touches a confirmed joint, which then needs confirming again. */
  unconfirms: boolean;
  reason?: string;
}
export interface WeldMapPlan {
  rows: PlanRow[];
  /** On the map already, absent from this file. Never deleted. */
  notInFile: string[];
  counts: { add: number; update: number; same: number; refused: number; notInFile: number };
}

export function planWeldMap(rows: WeldMapRow[], existing: ExistingJoint[]): WeldMapPlan {
  const have = new Map(existing.map((e) => [e.jointNo, e]));
  const out: PlanRow[] = rows.map((r) => {
    const e = have.get(r.jointNo);
    if (!e) return { ...r, action: "ADD", changes: [], unconfirms: false };
    const changes: FieldChange[] = [];
    let refusal: string | undefined;
    let jointType = e.jointType;
    if (r.typeGiven && r.jointType !== e.jointType) {
      if (e.used > 0) {
        refusal = `${r.jointNo} is a ${JOINT_TYPE_LABEL[e.jointType].toLowerCase()} with ${e.used} weld record${e.used === 1 ? "" : "s"} or step${e.used === 1 ? "" : "s"} against it, so its type cannot change to ${JOINT_TYPE_LABEL[r.jointType].toLowerCase()}. Fix the type in the file.`;
      } else {
        changes.push({ field: "jointType", from: e.jointType, to: r.jointType });
        jointType = r.jointType;
      }
    }
    // A blank cell never wipes what is on the map.
    const joins = r.joins ?? e.joins;
    const wpsRef = r.wpsRef ?? e.wpsRef;
    const ndtExtent = r.ndtExtent ?? e.ndtExtent;
    if (joins !== e.joins) changes.push({ field: "joins", from: e.joins, to: joins });
    if (wpsRef !== e.wpsRef) changes.push({ field: "wpsRef", from: e.wpsRef, to: wpsRef });
    if (ndtExtent !== e.ndtExtent) changes.push({ field: "ndtExtent", from: e.ndtExtent, to: ndtExtent });
    const action: PlanAction = refusal ? "REFUSED" : changes.length ? "UPDATE" : "SAME";
    return { row: r.row, jointNo: r.jointNo, jointType, joins, wpsRef, ndtExtent, action, changes, unconfirms: action === "UPDATE" && e.confirmed, ...(refusal ? { reason: refusal } : {}) };
  });
  const inFile = new Set(rows.map((r) => r.jointNo));
  const notInFile = existing.filter((e) => !inFile.has(e.jointNo)).map((e) => e.jointNo);
  const n = (a: PlanAction) => out.filter((r) => r.action === a).length;
  return { rows: out, notInFile, counts: { add: n("ADD"), update: n("UPDATE"), same: n("SAME"), refused: n("REFUSED"), notInFile: notInFile.length } };
}

// ---------------------------------------------------------------- add from tags

export type TagMode = "NOZZLES" | "JOINTS";
export interface TagJoint {
  jointNo: string;
  jointType: JointType;
  joins: string | null;
}
export const MAX_TAG_EXPANSION = 200;

/** What the standard prefixes mean, for the "Joins" text of a joint added by number. */
const PREFIX_JOINS: Array<[RegExp, string]> = [
  [/^NS-/, "Nozzle to shell or head"],
  [/^NF-/, "Nozzle to flange"],
  [/^SK-/, "Skirt to head"],
  [/^BR-/, "Base ring"],
  [/^GW-/, "Gusset"],
  [/^AT-/, "Attachment"],
];

/** "N1-N6, M1" or "GW-1...GW-32" to ["N1".."N6","M1"] / ["GW-1".."GW-32"]; errors in plain words. */
export function expandTagList(input: string): { tags: string[]; errors: string[] } {
  const tags: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (!seen.has(t)) {
      seen.add(t);
      tags.push(t);
    }
  };
  for (const raw of input.split(/[,;\n]+/)) {
    const tok = raw.trim().toUpperCase();
    if (!tok) continue;
    // N1-N6 | N1-6 | GW-1-GW-32 | GW-1...GW-32 | GW-1..32 | GW-1 to GW-32
    const m =
      /^([A-Z]+-?)(\d+)\s*-\s*(?:\1)?(\d+)$/.exec(tok) ??
      /^([A-Z][A-Z-]*?-?)(\d+)\s*(?:\.{2,3}|…|–|—|\bTO\b)\s*(?:\1)?(\d+)$/.exec(tok);
    if (m) {
      const [, prefix, a, b] = m;
      const from = Number(a);
      const to = Number(b);
      if (to < from) errors.push(`"${raw.trim()}" runs backwards.`);
      else if (to - from + 1 > MAX_TAG_EXPANSION) errors.push(`"${raw.trim()}" is more than ${MAX_TAG_EXPANSION} joints.`);
      else for (let i = from; i <= to; i++) push(`${prefix}${i}`);
      continue;
    }
    if (!JOINT_NO.test(tok)) errors.push(`"${raw.trim()}" is not a tag or joint number I can use.`);
    else push(tok);
  }
  if (tags.length > MAX_TAG_EXPANSION) errors.push(`More than ${MAX_TAG_EXPANSION} joints in one go.`);
  return { tags, errors };
}

/** Nozzle mode: each tag N1 becomes NS-N1 (to shell or head) and, with flanges, NF-N1. Joints mode: numbers as written. */
export function jointsFromTags(input: string, mode: TagMode, withFlanges: boolean): { joints: TagJoint[]; errors: string[] } {
  const { tags, errors } = expandTagList(input);
  const joints: TagJoint[] = [];
  const seen = new Set<string>();
  const add = (jointNo: string, joins: string | null) => {
    if (seen.has(jointNo)) return;
    seen.add(jointNo);
    joints.push({ jointNo, jointType: jointTypeFromNo(jointNo), joins });
  };
  for (const t of tags) {
    if (mode === "NOZZLES") {
      const bare = t.replace(/^N[SF]-/, "");
      add(`NS-${bare}`, `Nozzle ${bare} to shell or head`);
      if (withFlanges) add(`NF-${bare}`, `Nozzle ${bare} to flange`);
    } else {
      add(t, PREFIX_JOINS.find(([re]) => re.test(t))?.[1] ?? null);
    }
  }
  if (joints.length === 0 && errors.length === 0) errors.push("Type at least one tag or joint number.");
  return { joints, errors };
}
