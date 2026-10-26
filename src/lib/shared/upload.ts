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

/** The most lines one wizard BOM upload carries into a draft (the draft payload holds the parsed lines). */
export const BOM_UPLOAD_MAX_LINES = 500;
