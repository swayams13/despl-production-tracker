import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalizeXlsx } from "./xlsx-canonical";
import { parseMasterWorkbook } from "./master-import.parse";
import { ERROR_CODES } from "@/lib/shared/errors";
import { makeSparseWorkbook, makeZip } from "@/lib/shared/upload.test-util";

const MB = 1024 * 1024;
const small = Buffer.from("<x/>");
const entry = (i: number) => ({ name: `p${i}.xml`, data: small });
const zeros = (mb: number) => Buffer.alloc(mb * MB);

describe("canonicalizeXlsx — refusals", () => {
  const refused: Array<[string, Buffer, RegExp]> = [
    ["not a zip at all", Buffer.from("this is plainly not a workbook, just text".repeat(4)), /does not look like/],
    ["a central directory cut short", makeZip([entry(0), entry(1)]).subarray(0, -40), /does not look like/],
    ["no entries", makeZip([]), /does not look like/],
    ["too many entries", makeZip(Array.from({ length: 501 }, (_, i) => entry(i))), /parts inside/],
    ["a zip64 marker", makeZip([entry(0)], { zip64: true }), /zip format/],
    [
      "a part that inflates past 30 MB although its directory says 100 bytes",
      makeZip([{ name: "a.xml", data: zeros(31), declaredSize: 100, deflate: true }]),
      /too large once unpacked/,
    ],
    [
      "parts that are each fine but total past 80 MB",
      makeZip([0, 1, 2].map((i) => ({ name: `a${i}.xml`, data: zeros(29), deflate: true }))),
      /too large once unpacked/,
    ],
  ];
  it.each(refused)("refuses %s", (_n, bytes, msg) => {
    let err: { code?: string } | null = null as { code?: string } | null;
    try {
      canonicalizeXlsx(bytes);
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(JSON.stringify(err)).toMatch(msg);
  });
});

describe("canonicalizeXlsx — what the reader sees is what we measured", () => {
  it("ignores a second end-of-directory stub appended after the real one", () => {
    const benign = makeSparseWorkbook("Parts Master", "A1:C3");
    // A reader that scans from the last 4 bytes would follow this stub (fcnt 0) instead of the real directory.
    const withStub = Buffer.concat([benign, Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(16)]);
    expect(parseMasterWorkbook(withStub).sheets).toEqual(["Parts Master"]);
  });

  it("does not trust sizes written in a local file header", () => {
    const wb = Buffer.from(makeSparseWorkbook("Parts Master", "A1:C3"));
    wb.writeUInt32LE(0x7fffffff, 18); // first local header: compressed size
    wb.writeUInt32LE(0x7fffffff, 22); // first local header: uncompressed size
    expect(parseMasterWorkbook(wb).sheets).toEqual(["Parts Master"]);
  });

  it("emits a single stored zip containing exactly the entries it read", () => {
    const out = canonicalizeXlsx(makeSparseWorkbook("Parts Master", "A1:C3"));
    const eocd = out.length - 22;
    expect(out.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(out.readUInt16LE(eocd + 10)).toBe(5);
    expect(out.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(eocd);
  });

  const fixture = path.resolve(__dirname, "../../../docs/lean-core/inputs/2026-10-11-master-list/Standard_Parts_Master_PV_HE_SAMPLE.xlsx");
  it.skipIf(!existsSync(fixture))("round-trips the real 11 Oct workbook", () => {
    const out = canonicalizeXlsx(readFileSync(fixture));
    expect(out.length).toBeGreaterThan(readFileSync(fixture).length); // stored, so larger than the deflated original
    expect(out.length).toBeLessThan(30 * MB);
  });
});
