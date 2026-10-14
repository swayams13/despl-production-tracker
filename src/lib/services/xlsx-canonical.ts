import { inflateRawSync } from "node:zlib";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * An uploaded .xlsx is untrusted. The xlsx reader trusts the sizes in each zip
 * local header, scans for the end-of-directory record by its own rules and has
 * no inflate limit, so inspecting the file and then handing the same bytes to
 * it leaves gaps (a lying header, a second directory stub at the tail).
 *
 * So we never hand it the upload. We read the zip once, here, inflating each
 * entry with a real output limit, and return a NEW stored zip built from exactly
 * the bytes we counted. Whatever the reader parses is what we measured.
 */
export const XLSX_LIMITS = { entries: 500, entryBytes: 30 * 1024 * 1024, totalBytes: 80 * 1024 * 1024 } as const;

function refuse(reason: string): never {
  throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason });
}
const TOO_BIG = "This workbook is too large once unpacked (limit 30 MB for any part, 80 MB in all).";
const NOT_XLSX = "This does not look like an Excel workbook (.xlsx).";
const ZIP64 = "This workbook uses a zip format Excel does not normally write. Save it again from Excel.";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface StoredEntry {
  name: string;
  data: Buffer;
}

/** A plain stored (uncompressed) zip: one local header and one directory entry per file, nothing else. */
export function writeStoredZip(entries: StoredEntry[]): Buffer {
  const parts: Buffer[] = [];
  const dir: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    dir.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/**
 * Reads the zip's central directory, inflates every entry under a real output
 * limit, and returns a canonical stored zip. Throws a VALIDATION_FAILED refusal
 * (plain-English reason) for anything unreadable or over the limits.
 */
export function canonicalizeXlsx(bytes: Uint8Array): Buffer {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) refuse(NOT_XLSX);
  const count = b.readUInt16LE(end + 10);
  const cdOffset = b.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) refuse(ZIP64);
  if (count > XLSX_LIMITS.entries) refuse(`This workbook has ${count} parts inside; the limit is ${XLSX_LIMITS.entries}.`);

  const out: StoredEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) refuse(NOT_XLSX);
    const method = b.readUInt16LE(p + 10);
    const packed = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    if (packed === 0xffffffff || b.readUInt32LE(p + 24) === 0xffffffff || local === 0xffffffff) refuse(ZIP64);
    if (next > b.length) refuse(NOT_XLSX);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    p = next;
    if (name.endsWith("/")) continue;

    if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) refuse(NOT_XLSX);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (start + packed > b.length) refuse(NOT_XLSX);
    const packedData = b.subarray(start, start + packed);

    const room = Math.min(XLSX_LIMITS.entryBytes, XLSX_LIMITS.totalBytes - total);
    let data: Buffer;
    if (method === 0) {
      data = packedData;
      if (data.length > room) refuse(TOO_BIG);
    } else if (method === 8) {
      try {
        data = inflateRawSync(packedData, { maxOutputLength: Math.max(room, 1) });
      } catch (e) {
        // RangeError = hit the output limit; anything else = corrupt deflate stream.
        return refuse(e instanceof RangeError ? TOO_BIG : NOT_XLSX);
      }
    } else {
      return refuse(NOT_XLSX);
    }
    total += data.length;
    out.push({ name, data });
  }
  if (out.length === 0) refuse(NOT_XLSX);
  return writeStoredZip(out);
}
