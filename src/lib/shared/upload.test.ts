import { describe, expect, it } from "vitest";
import { checkWorkbookUpload, MAX_IMPORT_BYTES } from "./upload";

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
