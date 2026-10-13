import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MAX_SHEET_COLS, MAX_SHEET_ROWS, parseMasterWorkbook } from "./master-import.parse";
import { makeSparseWorkbook, makeZip } from "@/lib/shared/upload.test-util";
import { ERROR_CODES } from "@/lib/shared/errors";
import { makeWorkbook, PARTS_HEADER, ROUTES_HEADER } from "./master-import.test-util";

const part = (code: string, over: Partial<Record<number, string>> = {}) => {
  const base = ["PILOT", code, "Shell Course", "PV + HE", "Shell", "Made in-house", "Plate", "SA516", "ID", "Rolled shell (ID, T, L)", "A, B", "No", "Assumed – to be confirmed", "Precise", "Pending", "Draft", ""];
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v!;
  return base;
};

describe("parseMasterWorkbook", () => {
  it("finds headers by name, not position, and reads rows with their Excel row numbers", () => {
    // Columns deliberately reordered: Status and Part Code swapped.
    const header = [...PARTS_HEADER];
    [header[1], header[15]] = [header[15], header[1]];
    const row = part("SHL-01");
    [row[1], row[15]] = [row[15], row[1]];
    const wb = parseMasterWorkbook(makeWorkbook({ "Parts Master": { header, rows: [row] } }));
    expect(wb.parts).toHaveLength(1);
    expect(wb.parts[0]).toMatchObject({ code: "SHL-01", status: "Draft", name: "Shell Course", row: 5, variants: ["A", "B"] });
  });

  it("normalises line breaks and spacing in headers and values", () => {
    const wb = parseMasterWorkbook(
      makeWorkbook({
        "Part Routes": {
          header: ROUTES_HEADER,
          rows: [["PILOT", "SHL-01", "Shell", "A", "10", "  Cutting /   Blanking ", "x", "Fabrication Prep", "12", "13", "0.3", "Hours", "Per piece", "No", "", "", "", ""]],
        },
      }),
    );
    expect(wb.steps[0]).toMatchObject({ operation: "Cutting / Blanking", pvStage: "12", heStage: "13", stdTime: "0.3" });
  });

  it("skips EXAMPLE rows and blank padding rows, and counts the examples", () => {
    const wb = parseMasterWorkbook(
      makeWorkbook({
        "Parts Master": {
          header: PARTS_HEADER,
          rows: [part("SHL-01"), part("X", { 0: "EXAMPLE (PV)" }), part("", {}), part("HED-01")],
        },
      }),
    );
    expect(wb.parts.map((p) => p.code)).toEqual(["SHL-01", "HED-01"]);
    expect(wb.skippedExamples["Parts Master"]).toBe(1);
  });

  it("reports a missing sheet and a missing column instead of throwing", () => {
    const wb = parseMasterWorkbook(
      makeWorkbook({ "Parts Master": { header: PARTS_HEADER.filter((h) => h !== "Status"), rows: [part("SHL-01")] } }),
    );
    const byCode = (c: string) => wb.problems.filter((p) => p.code === c).map((p) => p.sheet);
    expect(byCode("COLUMN_MISSING")).toEqual(["Parts Master"]);
    expect(byCode("SHEET_MISSING")).toEqual(
      expect.arrayContaining(["Part Routes", "Material Master", "HE Stages", "Assembly Sequence"]),
    );
    expect(wb.parts).toEqual([]);
  });
});

describe("parseMasterWorkbook — the 11 Oct workbook (explicit M2 fixture)", () => {
  const file = path.resolve(__dirname, "../../../docs/lean-core/inputs/2026-10-11-master-list/Standard_Parts_Master_PV_HE_SAMPLE.xlsx");
  it.skipIf(!existsSync(file))("reads every sheet with no parse problems and the expected row counts", () => {
    const wb = parseMasterWorkbook(readFileSync(file));
    expect(wb.problems).toEqual([]);
    expect(wb.parts).toHaveLength(60);
    expect(wb.steps).toHaveLength(235);
    expect(wb.materials).toHaveLength(40);
    expect(wb.heStages).toHaveLength(42);
    expect(wb.pvStagesRef).toHaveLength(36);
    expect(wb.newOperations).toHaveLength(14);
    expect(wb.reviewActions).toHaveLength(34);
    // 57 assembly rows after the 9 grey EXAMPLE rows are dropped.
    expect(wb.assembly).toHaveLength(57);
    expect(wb.skippedExamples["Assembly Sequence"]).toBe(9);
  });
});

describe("parseMasterWorkbook — hostile input is refused, not parsed", () => {
  const refused = (b: Buffer) => {
    try {
      parseMasterWorkbook(b);
    } catch (e) {
      return e as { code: string; detail?: { reason?: string } };
    }
    return null;
  };

  it("refuses a few-KB workbook that declares a 16384 x 1048576 sheet, and does it fast", () => {
    const bytes = makeSparseWorkbook("Parts Master", "A1:XFD1048576");
    expect(bytes.length).toBeLessThan(5_000);
    const t = Date.now();
    const err = refused(bytes);
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(err?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it.each([
    ["one row too many", `A1:Q${MAX_SHEET_ROWS + 1}`],
    ["one column too many", `A1:${"DX"}10`], // DX = column 128 > 100
  ])("refuses a sheet with %s", (_n, dim) => {
    expect(refused(makeSparseWorkbook("Parts Master", dim))?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it("accepts a sheet exactly at the row and column ceilings", () => {
    const last = `${"CV"}${MAX_SHEET_ROWS}`; // CV = column 100
    expect(MAX_SHEET_COLS).toBe(100);
    expect(refused(makeSparseWorkbook("Parts Master", `A1:${last}`))).toBeNull();
  });

  it("does not read, so does not refuse, a sheet the importer never uses", () => {
    const wb = parseMasterWorkbook(makeSparseWorkbook("Pilot Review", "A1:XFD1048576"));
    expect(wb.sheets).toEqual(["Pilot Review"]);
    expect(wb.problems.map((p) => p.code)).toContain("SHEET_MISSING");
  });

  it("refuses a zip that declares 100 MB from a tiny file before inflating anything", () => {
    const bomb = makeZip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.from("<x/>"), declaredSize: 25 * 1024 * 1024 }]);
    expect(refused(bomb)?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });
});
