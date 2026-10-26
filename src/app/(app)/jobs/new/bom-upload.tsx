"use client";

import { useRef, useState, useTransition } from "react";
import { previewBomUploadAction } from "@/app/actions/job-draft";
import type { BomUploadPreview } from "@/lib/services/bom-upload.service";
import { plural } from "@/lib/shared/plural";
import { BOM_UPLOAD_MAX_LINES, checkWorkbookUpload } from "@/lib/shared/upload";
import type { BomUploadState } from "./wizard-state";

const SHOW_ROWS = 8;
const SHOW_FAILURES = 10;

/** The lines a line keeps: a short table, so the person can see what the file became. */
function LinesTable({ lines }: { lines: BomUploadState["lines"] }) {
  return (
    <table>
      <thead><tr><th className="num">Item</th><th>Part name</th><th>Material</th><th className="num">Qty</th><th>Component type</th></tr></thead>
      <tbody>
        {lines.slice(0, SHOW_ROWS).map((l, i) => (
          <tr className="row" key={i}>
            <td className="num mono">{l.itemNo}</td>
            <td>{l.partName}</td>
            <td>{l.material ?? "—"}</td>
            <td className="num mono">{l.sourceQty}</td>
            <td>{l.componentType ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Wizard "Upload a BOM Excel file" for one equipment line: choose the file, check what the server
 * read from it, then keep the lines. Nothing is created until the job is.
 */
export function BomUpload({
  lineNo,
  value,
  onKeep,
  onRemove,
}: {
  lineNo: number;
  value: BomUploadState | null;
  onKeep: (u: BomUploadState) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<BomUploadPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (file: File) => {
    setError(null);
    setPreview(null);
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const problem = checkWorkbookUpload({ name: file.name, size: file.size, head });
    if (problem) return setError(problem);
    const fd = new FormData();
    fd.set("file", file);
    start(async () => {
      const r = await previewBomUploadAction(fd);
      if (!r.ok) return setError(typeof r.detail?.reason === "string" ? r.detail.reason : r.message);
      setPreview(r.preview ?? null);
    });
  };

  return (
    <div style={{ marginTop: 8 }}>
      <input
        ref={input}
        type="file"
        accept=".xlsx"
        aria-label={`BOM Excel file for line ${lineNo}`}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void choose(f);
        }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" disabled={pending} onClick={() => input.current?.click()}>
          {pending ? "Reading the file…" : value ? "Choose a different file" : "Choose a BOM Excel file…"}
        </button>
        <span className="emp-hint">.xlsx with a header row (Item No, Part Name, Qty; Material, Component Type and others optional). Up to {BOM_UPLOAD_MAX_LINES} lines.</span>
      </div>
      {error && <div className="ws-err" role="alert">{error}</div>}

      {preview && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="hd"><h3>{preview.fileName}</h3></div>
          <div style={{ padding: 16 }}>
            <div>
              {plural(preview.lines.length, "line")} can be read{preview.failures.length > 0 ? `; ${plural(preview.failures.length, "row")} cannot` : ""}. Sheet: {preview.sheetName}.
            </div>
            <div className="emp-hint" style={{ margin: "8px 0 4px" }}>How the columns were read</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {preview.columns.map((c, i) => (
                <span key={i} className={`chip ${c.readAs ? "c-complete" : "c-hold"}`}><i />{c.header}{c.readAs ? ` → ${c.readAs}` : ": not used"}</span>
              ))}
            </div>
            {preview.warnings.map((w, i) => <div className="emp-hint" key={i} style={{ marginTop: 6 }}>{w}</div>)}
            {preview.failures.length > 0 && (
              <div className="ws-err" style={{ marginTop: 8 }}>
                <div>These rows will be left out:</div>
                <ul style={{ margin: "4px 0 0 18px" }}>
                  {preview.failures.slice(0, SHOW_FAILURES).map((f) => <li key={f.row}>Excel row {f.row}: {f.error}</li>)}
                  {preview.failures.length > SHOW_FAILURES && <li>and {preview.failures.length - SHOW_FAILURES} more</li>}
                </ul>
              </div>
            )}
            <div className="emp-hint" style={{ margin: "10px 0 4px" }}>First {Math.min(SHOW_ROWS, preview.lines.length)} of {plural(preview.lines.length, "line")}</div>
            <LinesTable lines={preview.lines} />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="btn btn-accent" onClick={() => { onKeep({ fileName: preview.fileName, lines: preview.lines }); setPreview(null); }}>
                Use these {plural(preview.lines.length, "line")}
              </button>
              <button className="btn" onClick={() => setPreview(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {!preview && value && (
        <div style={{ marginTop: 10 }}>
          <div className="emp-hint">
            {plural(value.lines.length, "line")} from {value.fileName || "the uploaded file"} go into the BOM as a draft. Engineering checks them and releases the BOM.
          </div>
          <LinesTable lines={value.lines} />
          {value.lines.length > SHOW_ROWS && <div className="emp-hint">and {value.lines.length - SHOW_ROWS} more</div>}
          <button className="btn" style={{ marginTop: 8 }} onClick={onRemove}>Remove the file&apos;s lines</button>
        </div>
      )}
    </div>
  );
}
