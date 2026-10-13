/**
 * Upload checks shared by the browser (before sending) and the Server Action
 * (before trusting the bytes). Pure. An .xlsx is a zip, so it starts "PK\x03\x04".
 */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export function checkWorkbookUpload(file: { name: string; size: number; head: ArrayLike<number> }): string | null {
  if (!/\.xlsx$/i.test(file.name)) return "Choose an Excel workbook (.xlsx).";
  if (file.size <= 0) return "This file is empty.";
  if (file.size > MAX_IMPORT_BYTES) return `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 4 MB.`;
  const h = file.head;
  if (!(h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04)) return "This does not look like an Excel workbook (.xlsx).";
  return null;
}

export const ZIP_LIMITS = { entries: 500, entryBytes: 30 * 1024 * 1024, totalBytes: 80 * 1024 * 1024, ratio: 100 } as const;

/**
 * Reads only the zip's central directory (never inflates) and refuses a workbook
 * that declares too many entries, too much data, or an implausible compression
 * ratio. A ceiling, not a guarantee: declared sizes can lie and the xlsx reader
 * has no inflate limit of its own, so this stops the cheap attacks, not a
 * crafted one. Returns a plain-English reason, or null.
 */
export function inspectZip(b: Uint8Array): string | null {
  const unreadable = "This does not look like an Excel workbook (.xlsx).";
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return unreadable;
  const count = v.getUint16(end + 10, true);
  const cdSize = v.getUint32(end + 12, true);
  const cdOffset = v.getUint32(end + 16, true);
  const zip64 = "This workbook uses a zip format Excel does not normally write. Save it again from Excel.";
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return zip64;
  if (count > ZIP_LIMITS.entries) return `This workbook has ${count} parts inside; the limit is ${ZIP_LIMITS.entries}.`;

  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) return unreadable;
    const packed = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    if (packed === 0xffffffff || size === 0xffffffff) return zip64;
    if (size > ZIP_LIMITS.entryBytes) return "A part of this workbook is too large once unpacked (limit 30 MB).";
    total += size;
    p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  if (total > ZIP_LIMITS.totalBytes) return "This workbook is too large once unpacked (limit 80 MB).";
  if (total > b.length * ZIP_LIMITS.ratio) return "This workbook is compressed far more than a normal Excel file. Save it again from Excel.";
  return null;
}
