import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { checkWorkbookUpload, inspectZip, MAX_IMPORT_BYTES } from "./upload";
import { makeSparseWorkbook, makeZip } from "./upload.test-util";

const zip = [0x50, 0x4b, 0x03, 0x04];
describe("checkWorkbookUpload", () => {
  const ok = { name: "Standard_Parts_Master.xlsx", size: 183_000, head: zip };
  it("accepts a workbook", () => expect(checkWorkbookUpload(ok)).toBeNull());

  const refused: Array<[string, Parameters<typeof checkWorkbookUpload>[0], RegExp]> = [
    ["a CSV", { ...ok, name: "parts.csv" }, /\.xlsx/],
    ["an old .xls", { ...ok, name: "parts.xls" }, /\.xlsx/],
    ["an empty file", { ...ok, size: 0 }, /empty/],
    ["a file past the limit", { ...ok, size: MAX_IMPORT_BYTES + 1 }, /limit is 4 MB/],
    ["a renamed text file", { ...ok, head: [0x68, 0x65, 0x6c, 0x6c] }, /does not look like/],
  ];
  it.each(refused)("refuses %s", (_n, file, msg) => {
    expect(checkWorkbookUpload(file)).toMatch(msg);
  });
  it("is case-insensitive on the extension and exact at the limit", () => {
    expect(checkWorkbookUpload({ ...ok, name: "PARTS.XLSX", size: MAX_IMPORT_BYTES })).toBeNull();
  });
});

describe("inspectZip", () => {
  const small = Buffer.from("<x/>");
  const MB = 1024 * 1024;
  const entry = (i: number, declaredSize?: number) => ({ name: `p${i}.xml`, data: small, declaredSize });

  const refused: Array<[string, Buffer, RegExp]> = [
    ["not a zip at all", Buffer.from("this is plainly not a workbook, just text".repeat(4)), /does not look like/],
    ["too many entries", makeZip(Array.from({ length: 501 }, (_, i) => entry(i))), /parts inside/],
    ["one entry past 30 MB", makeZip([entry(0, 31 * MB)]), /30 MB/],
    ["a total past 80 MB", makeZip([entry(0, 29 * MB), entry(1, 29 * MB), entry(2, 29 * MB)]), /80 MB/],
    ["a ratio past 100:1", makeZip([entry(0, 20 * MB)]), /compressed far more/],
    ["a zip64 marker", makeZip([entry(0)], { zip64: true }), /zip format/],
    ["a central directory cut short", makeZip([entry(0), entry(1)]).subarray(0, -40), /does not look like/],
  ];
  it.each(refused)("refuses %s", (_n, bytes, msg) => {
    expect(inspectZip(bytes)).toMatch(msg);
  });

  it("accepts an ordinary workbook-shaped zip, and exactly the entry ceiling", () => {
    expect(inspectZip(makeSparseWorkbook("Parts Master", "A1:C3"))).toBeNull();
    expect(inspectZip(makeZip(Array.from({ length: 500 }, (_, i) => entry(i))))).toBeNull();
  });

  const fixture = path.resolve(__dirname, "../../../docs/lean-core/inputs/2026-10-11-master-list/Standard_Parts_Master_PV_HE_SAMPLE.xlsx");
  it.skipIf(!existsSync(fixture))("accepts the real 11 Oct workbook", () => {
    expect(inspectZip(readFileSync(fixture))).toBeNull();
  });
});
