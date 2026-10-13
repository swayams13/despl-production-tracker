import * as XLSX from "xlsx";

/** Test helper: builds an in-memory workbook with a banner above the header, like the real one. */
export interface SheetSpec {
  header: string[];
  rows: string[][];
  /** Rows of banner text above the header (the real sheets have 3). */
  banner?: number;
}

export function makeWorkbook(sheets: Record<string, SheetSpec>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, spec] of Object.entries(sheets)) {
    const banner = Array.from({ length: spec.banner ?? 3 }, (_, i) => [`${name} banner ${i + 1}`]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...banner, spec.header, ...spec.rows]), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export const PARTS_HEADER = [
  "Example?", "Part Code", "Part Name", "Equipment", "Assembly Group", "Make / Buy", "Raw Material Form",
  "Typical MOC", "Dimensions to enter per job", "Weight Basis", "Route Variants\n(A, B…)", "Also a Spare?",
  "Route Source", "Filled by", "Checked by", "Status", "Remarks",
];

export const ROUTES_HEADER = [
  "Example?", "Part Code", "Part Name\n(auto)", "Variant", "Seq", "Operation", "What is done in this step",
  "Department", "Counts toward\nPV Stage No.", "Counts toward\nHE Stage No.", "Std. Time", "Time Unit", "Time Basis",
  "Conditional?", "When does it apply?", "Acceptance Standard", "Record / Document", "Remarks",
];
