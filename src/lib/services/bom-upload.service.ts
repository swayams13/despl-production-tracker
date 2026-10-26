import * as XLSX from "xlsx";
import { withTenant } from "@/lib/db";
import { assertNotClientUser, requireRole, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { BomUploadLine } from "@/lib/shared/schemas";
import { BOM_UPLOAD_MAX_LINES, checkWorkbookUpload } from "@/lib/shared/upload";
import { IMPORT_HEADER_ALIASES, parseImportRow, resolveComponentTypeCodes, unrecognisedCodes } from "./bom.service";
import { JOB_PREVIEW_ROLES } from "./job-preview.service";
import { canonicalizeXlsx } from "./xlsx-canonical";

/**
 * Wizard "Upload a BOM Excel file": a dry run. The bytes are read here, on the server, through the
 * same header aliases and row schema `importBomItems` uses (bom.service.ts `parseImportRow`), and the
 * valid lines go back to the browser to be kept in the draft. Nothing is written: the lines become
 * DRAFT BOM revision 1 only when the job is created (`createJobTx`), exactly as the kit and a copied
 * job do.
 */

export interface BomUploadPreview {
  fileName: string;
  sheetName: string;
  /** Data rows in the sheet (blank rows are not counted). */
  totalRows: number;
  /** The readable lines: what the draft keeps and the job creates. */
  lines: BomUploadLine[];
  /** Every column header in the file and the BOM field it was read as (null = not used). */
  columns: Array<{ header: string; readAs: string | null }>;
  /** Rows that could not be read, by Excel row number. */
  failures: Array<{ row: number; error: string }>;
  warnings: string[];
}

/** What a column reads as, in the words on the screen. */
const FIELD_LABEL: Record<string, string> = {
  itemNo: "Item no",
  blockNo: "Block no",
  partName: "Part name",
  description: "Description",
  material: "Material",
  sourceQty: "Quantity",
  qtyPer: "Quantity per unit",
  uom: "UOM",
  unit: "Unit",
  remarks: "Remarks",
  parentBomItemId: "Parent item",
  componentType: "Component type",
};
const REQUIRED_FIELDS = ["itemNo", "partName", "sourceQty"] as const;

const fieldOf = (header: string): string | null => IMPORT_HEADER_ALIASES[header.trim().toLowerCase().replace(/[\s_.-]+/g, "")] ?? null;
const refuse = (reason: string) => new AppError(ERROR_CODES.VALIDATION_FAILED, { reason }, reason);

export async function previewBomUpload(actor: Actor, input: { fileName: string; bytes: Buffer | Uint8Array }): Promise<BomUploadPreview> {
  assertNotClientUser(actor);
  requireRole(actor, ...JOB_PREVIEW_ROLES);

  const problem = checkWorkbookUpload({ name: input.fileName, size: input.bytes.length, head: input.bytes.subarray(0, 4) });
  if (problem) throw refuse(problem);

  // Untrusted bytes: only the canonical re-pack reaches the reader, first sheet only, capped rows (as the other importers).
  const wb = XLSX.read(canonicalizeXlsx(input.bytes), { type: "buffer", sheetRows: BOM_UPLOAD_MAX_LINES + 2 });
  const sheetName = wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!ws || !ws["!ref"]) throw refuse("The first sheet of this workbook is empty. Put the BOM on the first sheet, with a header row.");
  const headerRow = (XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false })[0] ?? []) as unknown[];
  const headers = headerRow.map((h) => (h == null ? "" : String(h).trim())).filter(Boolean);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: undefined });
  if (rows.length === 0) throw refuse("The sheet has a header row but no BOM lines under it.");
  // sheetRows stops the reader one row past the cap, so more than the cap here means the file has more.
  if (rows.length > BOM_UPLOAD_MAX_LINES) {
    throw refuse(`This file has more than ${BOM_UPLOAD_MAX_LINES} lines. The wizard takes up to ${BOM_UPLOAD_MAX_LINES}: create the job with the first part, then import the rest on the BOM panel.`);
  }

  const fields = headers.map(fieldOf);
  const columns = headers.map((header, i) => ({ header, readAs: fields[i] ? FIELD_LABEL[fields[i]!] : null }));
  const present = new Set(fields);
  const missing = REQUIRED_FIELDS.filter((f) => !present.has(f));
  if (missing.length > 0) {
    throw refuse(`The file needs a column for ${missing.map((f) => FIELD_LABEL[f]).join(", ")}. Download the BOM template from the BOM panel for the column names.`);
  }

  const lines: BomUploadLine[] = [];
  const failures: BomUploadPreview["failures"] = [];
  const excelRowOfLine: number[] = [];
  for (const raw of rows) {
    // __rowNum__ is the 0-based sheet row; the header is row 1 in Excel.
    const excelRow = ((raw as { __rowNum__?: number }).__rowNum__ ?? 0) + 1;
    const r = parseImportRow(raw);
    if (!r.ok) {
      failures.push({ row: excelRow, error: r.error });
      continue;
    }
    const { parentBomItemId: _parent, ...line } = r.data;
    lines.push(line);
    excelRowOfLine.push(excelRow);
  }
  if (lines.length === 0) {
    throw refuse(`None of the ${rows.length} rows could be read. ${failures.slice(0, 3).map((f) => `Row ${f.row}: ${f.error}`).join(" ")}`);
  }

  const warnings: string[] = [];
  const ignored = columns.filter((c) => c.readAs == null).map((c) => c.header);
  if (ignored.length > 0) warnings.push(`${ignored.length === 1 ? "This column is" : "These columns are"} not used: ${ignored.join(", ")}.`);
  if (fields.includes("parentBomItemId")) warnings.push("The parent item column is not used here. Lines are added flat; set parents on the BOM panel after the job is created.");
  const rowsOfItemNo = new Map<number, number[]>();
  lines.forEach((l, i) => rowsOfItemNo.set(l.itemNo, [...(rowsOfItemNo.get(l.itemNo) ?? []), excelRowOfLine[i]]));
  for (const [itemNo, at] of rowsOfItemNo) if (at.length > 1) warnings.push(`Item no ${itemNo} appears on rows ${at.join(", ")}.`);

  // A component type code that does not resolve fails the whole file, as in the BOM panel's import: nothing half-landed.
  const codes = [...new Set(lines.flatMap((l) => (l.componentType ? [l.componentType] : [])))];
  const known = await withTenant(actor.tenantId, (tx) => resolveComponentTypeCodes(tx, actor.tenantId, codes));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length > 0) throw refuse(unrecognisedCodes(unknown));

  return { fileName: input.fileName, sheetName, totalRows: rows.length, lines, columns, failures, warnings };
}
