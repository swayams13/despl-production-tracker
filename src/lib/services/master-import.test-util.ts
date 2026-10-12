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

export interface WorkbookOver {
  status?: string;
  routeSource?: string;
  time2?: string;
  density?: string;
  /** Material specification text (default "SA 516"); for case-variant tests. */
  materialSpec?: string;
  /** Extra HE stages (stage no, name, department, predecessors). */
  heStages?: string[][];
  /** Replace the single part's code. */
  code?: string;
}

/** One PV part (two route steps), one material, optional HE stages. */
export function standardWorkbook(over: WorkbookOver = {}): Buffer {
  const code = over.code ?? "SHL-01";
  return makeWorkbook({
    "Parts Master": {
      header: PARTS_HEADER,
      rows: [["PILOT", code, "Shell Course", "PV", "Shell", "Made in-house", "Plate", "SA516", "ID, T, L", "Rolled shell (ID, T, L)", "A", "No", over.routeSource ?? "Current shop practice", "", "", over.status ?? "Approved by Production Head", ""]],
    },
    "Part Routes": {
      header: ROUTES_HEADER,
      rows: [
        ["PILOT", code, "Shell Course", "A", "10", "Receipt", "Plate received", "Stores", "10", "", "0.5", "Hours", "Per piece", "No", "", "GRN accepted", "GRN", ""],
        ["PILOT", code, "Shell Course", "A", "20", "MTC Verification / Material Identification", "MTC reviewed", "Quality Control / QA", "11", "", over.time2 ?? "0.75", "Hours", "Per material lot", "No", "", "", "", ""],
      ],
    },
    "Material Master": {
      header: ["Example?", "Material Specification", "Grade / UNS", "Product Form", "Density (g/cm³)", "Remarks"],
      rows: [["REFERENCE", over.materialSpec ?? "SA 516", "Gr.70", "Plate", over.density ?? "7.85", ""]],
    },
    "HE Stages": {
      header: ["Example?", "HE Type", "Stage No.", "Stage Name", "Main Activities", "Department", "Duration Min (days)", "Duration Max (days)", "Predecessor Stage No(s).", "Link Type", "Lag / Overlap (days)", "Optional?", "When is it optional?", "Remarks"],
      rows: (over.heStages ?? []).map((s) => ["PROPOSED", "Fixed", s[0], s[1], "", s[2], "1", "2", s[3] ?? "—", "Finish-to-Start", "0", "No", "", ""]),
    },
    "PV Stages (ref)": {
      header: ["Stage No.", "Stage Name", "Main Activities", "Department"],
      rows: [["10", "Receipt", "", "Stores"], ["11", "Identification", "", "Quality Control / QA"]],
    },
    "Assembly Sequence": { header: ["Example?", "Equipment Type", "Activity"], rows: [] },
    "New Operations": { header: ["Example?", "Proposed Operation"], rows: [] },
    "Review Actions": { header: ["ID", "Issue or Decision Required"], rows: [] },
  });
}
