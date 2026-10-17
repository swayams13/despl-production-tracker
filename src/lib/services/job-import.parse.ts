import * as XLSX from "xlsx";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { parseTrackerGrid, type Cell, type ParsedTracker } from "@/lib/shared/job-import";
import { canonicalizeXlsx } from "./xlsx-canonical";

/**
 * Lean Core L2.10: bytes of a DESPL tracker workbook to a ParsedTracker.
 * Untrusted input, so the reader only sees the canonical re-pack of the upload
 * (every entry inflated under a real limit, see xlsx-canonical.ts), only the
 * first sheet, and a capped range, as the M2 importer does.
 */
export const MAX_TRACKER_ROWS = 2000;
export const MAX_TRACKER_COLS = 100;

export function parseTrackerWorkbook(bytes: Buffer | Uint8Array): ParsedTracker {
  const wb = XLSX.read(canonicalizeXlsx(bytes), { type: "buffer", sheetRows: MAX_TRACKER_ROWS, cellNF: true });
  const name = wb.SheetNames[0];
  const ws = name ? wb.Sheets[name] : undefined;
  if (!ws || !ws["!ref"]) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "The workbook has no sheet with data." });
  const dim = ws["!fullref"] ?? ws["!ref"];
  const full = XLSX.utils.decode_range(dim);
  if (full.e.r - full.s.r + 1 > MAX_TRACKER_ROWS || full.e.c - full.s.c + 1 > MAX_TRACKER_COLS) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      reason: `The sheet is larger than the importer reads (${MAX_TRACKER_ROWS} rows by ${MAX_TRACKER_COLS} columns). Remove empty rows and columns and try again.`,
    });
  }
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const grid: Cell[][] = [];
  for (let r = 0; r <= range.e.r; r++) {
    const row: Cell[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) { row.push(null); continue; }
      if (cell.t === "n" && typeof cell.v === "number" && cell.z && XLSX.SSF.is_date(String(cell.z))) {
        const d = XLSX.SSF.parse_date_code(cell.v);
        row.push(d ? { iso: `${String(d.y).padStart(4, "0")}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` } : null);
      } else if (cell.t === "n") row.push(cell.v as number);
      else if (cell.t === "b") row.push(Boolean(cell.v));
      else if (cell.t === "s" || cell.t === "str") row.push(String(cell.v));
      else row.push(null);
    }
    grid.push(row);
  }
  return parseTrackerGrid(grid);
}
