import type { Cell } from "./job-import";

/**
 * Test fixtures for the L2.10 tracker import: a grid with the real DE0467
 * header (group row, column names, line breaks and all), none of its data.
 */
const GROUPS: Array<[string, string[]]> = [
  ["BOM DETAILS", ["Item No.", "Part Name", "Description", "Material", "Qty", "Unit"]],
  ["PROCUREMENT TRACKING", ["Indent No.", "Indent Generate Date", "Indent Approved Date", "Procurement \r\nStatus", "PO No.", "PO Date", "Material Received Status", "Material Received Date"]],
  ["QC", ["Material \r\nIdentification", "Material Identification Date"]],
  ["MANUFACTURING PROCESSES", ["Cutting", "Bending", "Machining", "Set-up", "Welding", "Shot Blasting", "Painting"].flatMap((p) => [`${p} Type`, `${p} Start`, `${p} End`])],
  ["TESTING & QC", ["RT", "UT", "HT", "Pneumatic", "DP", "Vacuum"].flatMap((p) => [`${p} Type`, `${p} Start`, `${p} End`, `${p} Result`])],
  ["FINAL", ["Overall Status", "Remarks"]],
];
export const HEADERS = GROUPS.flatMap(([, h]) => h);
export const GROUP_ROW: Cell[] = GROUPS.flatMap(([g, h]) => h.map((_, i) => (i === 0 ? g : null)));
export const col = (name: string) => HEADERS.findIndex((h) => h.replace(/\s+/g, " ") === name);

export const row = (cells: Record<string, Cell>): Cell[] => {
  const r: Cell[] = HEADERS.map(() => null);
  for (const [k, v] of Object.entries(cells)) {
    const i = col(k);
    if (i < 0) throw new Error(`no column ${k}`);
    r[i] = v;
  }
  return r;
};
export const iso = (d: string): Cell => ({ iso: d });

export function sheet(body: Cell[][], tail: Cell[][] = []): Cell[][] {
  const pad = (r: Cell[]) => [...r, ...HEADERS.map(() => null)].slice(0, HEADERS.length);
  return [
    pad(["PROJECT TRACKING - BOM & MANUFACTURING TRACKER"]),
    pad(["Work Order No. ", null, "Order Generate Date", null, "Project Name", null, "Dispatch Date", "QTY-05 NOS."]),
    pad(["DE0455-01", null, "24.06.2026 & Revised order Dt.13.07.2026", null, "PRESSURE PIPE 8\"", null, "15.10.2026 - 25.10.2026"]),
    GROUP_ROW,
    HEADERS as Cell[],
    ...body,
    ...tail,
  ];
}

export const item = (no: number, name: string, over: Record<string, Cell> = {}) =>
  row({ "Item No.": String(no), "Part Name": name, Qty: "1", Unit: "NOS", ...over });

