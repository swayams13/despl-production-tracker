"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import { PageHeader } from "@/components/industrial/page-header";
import { applyTrackerImportAction, previewTrackerImportAction } from "@/app/actions/job-import";
import type { ApplyReport, ImportTarget, TrackerReport } from "@/lib/services/job-import.service";
import type { Issue, Severity } from "@/lib/shared/job-import";
import { checkWorkbookUpload } from "@/lib/shared/upload";

/**
 * Lean Core L2.10 part A. Choose the sheet, check it (nothing is written),
 * say which equipment each block is, read the issues, load. The file stays in
 * the browser and goes up with every call; Load only works on the file and the
 * plan that were just checked.
 */

const SHOW_FIRST = 100;
const SEVERITY_LABEL: Record<Severity, string> = { ERROR: "Errors", WARNING: "To check", INFO: "Notes" };
const CHIP: Record<Severity, string> = { ERROR: "c-overdue", WARNING: "c-hold", INFO: "c-idle" };
const WORD: Record<Severity, string> = { ERROR: "Error", WARNING: "Check", INFO: "Note" };
const ACTION_LABEL = { CREATE: "Will load", SKIP_EXISTS: "Already in the job", SKIP_CONFLICT: "Different part, not loaded", SKIP_ERROR: "Error, not loaded" } as const;

type Choice = { equipmentId: number } | { newName: string };

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function reasonOf(r: { ok: false; message: string; detail?: Record<string, unknown> }): string {
  const reason = r.detail?.reason;
  return typeof reason === "string" ? reason : r.message;
}

export function TrackerImport({ target }: { target: ImportTarget }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [report, setReport] = useState<TrackerReport | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [dirty, setDirty] = useState(false);
  const [applied, setApplied] = useState<ApplyReport | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [checking, startChecking] = useTransition();
  const [applying, startApplying] = useTransition();

  const reset = () => {
    setReport(null);
    setChoices({});
    setDirty(false);
    setApplied(null);
    setBanner(null);
    setOpen(new Set());
  };

  const pick = async (f: File | null) => {
    reset();
    setFile(null);
    setFileProblem(null);
    if (!f) return;
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    const problem = checkWorkbookUpload({ name: f.name, size: f.size, head });
    if (problem) setFileProblem(problem);
    else setFile(f);
  };

  const formFor = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("file", file as File);
    fd.set("jobId", String(target.jobId));
    const list = Object.entries(choices).map(([blockNo, c]) => ({ blockNo: Number(blockNo), ...c }));
    if (list.length) fd.set("choices", JSON.stringify(list));
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  };

  const check = () =>
    startChecking(async () => {
      setBanner(null);
      setApplied(null);
      const r = await previewTrackerImportAction(formFor());
      if (r.ok && r.report) {
        setReport(r.report);
        setDirty(false);
        // keep what the person chose; fill the rest from the suggestions
        setChoices((cur) => {
          const next: Record<number, Choice> = {};
          for (const b of r.report!.blocks) next[b.blockNo] = cur[b.blockNo] ?? b.target;
          return next;
        });
        setOpen(new Set());
        return;
      }
      setReport(null);
      setBanner(r.ok ? "Could not read that file." : reasonOf(r));
    });

  const load = () =>
    startApplying(async () => {
      if (!report) return;
      const r = await applyTrackerImportAction(formFor({ fileSha256: report.fileSha256, planFingerprint: report.planFingerprint }));
      setConfirmOpen(false);
      if (r.ok && r.applied) {
        setApplied(r.applied);
        setReport(null);
        toast.success("Loaded into the job.");
        router.refresh();
        return;
      }
      setBanner(r.ok ? "Nothing was loaded." : reasonOf(r));
    });

  const setChoice = (blockNo: number, c: Choice) => {
    setChoices((cur) => ({ ...cur, [blockNo]: c }));
    setDirty(true);
  };

  const byCode = new Map<string, { severity: Severity; title: string; issues: Issue[] }>();
  for (const i of report?.issues ?? []) {
    const g = byCode.get(i.code) ?? { severity: i.severity, title: i.code.charAt(0) + i.code.slice(1).toLowerCase().replace(/_/g, " "), issues: [] };
    g.issues.push(i);
    byCode.set(i.code, g);
  }
  const groups = [...byCode.entries()].sort((a, b) => ["ERROR", "WARNING", "INFO"].indexOf(a[1].severity) - ["ERROR", "WARNING", "INFO"].indexOf(b[1].severity));
  const toggle = (k: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const blocked = !report ? null : dirty ? "You changed an equipment choice. Check the file again before loading." : !report.canApply ? "There is nothing to load." : null;

  return (
    <>
      <PageHeader title="Load tracker sheet" subtitle={`Into ${target.jobNumber}${target.projectName ? ` · ${target.projectName}` : ""}`} />
      <p className="note" style={{ textAlign: "left", margin: "0 0 12px" }}>
        Reads DESPL&apos;s Excel tracker (the DE0463 / DE0467 layout). Loads the equipment, the BOM items and their procurement dates. The
        manufacturing and test columns, drawings and assembly processes are read and counted but loaded later, when parts have routes.{" "}
        <Link href={`/jobs/${target.jobId}?tab=materials&view=parts`}>Back to the job</Link>
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Sheet</h3></div>
        <div style={{ padding: "0 16px 16px", display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 6, fontSize: "var(--fs-md, 13px)" }}>
            Choose the Excel file (.xlsx, up to 4 MB)
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label="Tracker sheet"
              onChange={(e) => void pick(e.target.files?.[0] ?? null)}
            />
          </label>
          {fileProblem && <p role="alert" style={{ margin: 0, color: "var(--s-overdue)", fontSize: "var(--fs-md, 13px)" }}>{fileProblem}</p>}
          {file && <p style={{ margin: 0, fontSize: "var(--fs-md, 13px)" }}><span className="mono">{file.name}</span> · {kb(file.size)}</p>}
          <div>
            <button type="button" className="btn btn-accent" disabled={!file || checking} onClick={check}>
              {checking ? "Checking…" : report ? "Check again" : "Check file"}
            </button>
          </div>
        </div>
      </div>

      {banner && (
        <div role="alert" className="card" style={{ marginBottom: 14, padding: 12 }}>
          <span className="chip c-overdue"><i />{banner}</span>
        </div>
      )}

      {report && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hd">
              <h3>Which equipment is each block?</h3>
              <span className="note" style={{ margin: "0 0 0 auto" }}>
                {report.header.workOrderNo ? `Sheet: ${report.header.workOrderNo}` : "Sheet"}
                {report.header.projectName ? ` · ${report.header.projectName.replace(/\s+/g, " ")}` : ""}
              </span>
            </div>
            <div style={{ padding: "0 16px 14px", display: "grid", gap: 12 }}>
              {report.blocks.length === 0 && <p className="note" style={{ textAlign: "left", margin: 0 }}>No items were found.</p>}
              {report.blocks.map((b) => {
                const c = choices[b.blockNo] ?? b.target;
                const isNew = "newName" in c;
                return (
                  <div key={b.blockNo} style={{ display: "grid", gap: 6, fontSize: "var(--fs-md, 13px)" }}>
                    <b>
                      Block {b.blockNo}{b.label ? ` · ${b.label}` : ""}{" "}
                      <span style={{ fontWeight: 400, color: "var(--muted)" }}>{plural(b.itemCount, "item")}, from row {b.firstRow}</span>
                    </b>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <select
                        aria-label={`Equipment for block ${b.blockNo}`}
                        className="ws-detail"
                        value={isNew ? "new" : String((c as { equipmentId: number }).equipmentId)}
                        onChange={(e) =>
                          setChoice(b.blockNo, e.target.value === "new" ? { newName: "newName" in c ? c.newName : `${target.jobNumber}-B${b.blockNo}` } : { equipmentId: Number(e.target.value) })
                        }
                      >
                        <option value="new">New equipment…</option>
                        {target.equipment.map((e) => (
                          <option key={e.id} value={e.id}>{e.name} ({plural(e.itemCount, "item")} now)</option>
                        ))}
                      </select>
                      {isNew && (
                        <input
                          className="ws-detail"
                          aria-label={`Name of the new equipment for block ${b.blockNo}`}
                          value={(c as { newName: string }).newName}
                          maxLength={120}
                          onChange={(e) => setChoice(b.blockNo, { newName: e.target.value })}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hd"><h3>What this file would do</h3></div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <tbody>
                  {(
                    [
                      ["Blocks in the sheet", report.counts.blocks],
                      ["Items in the sheet", report.counts.items],
                      ["Will load", report.counts.create],
                      ["Already in the job (left as they are)", report.counts.exists],
                      ["Different part under the same number (not loaded)", report.counts.conflict],
                      ["Errors (not loaded)", report.counts.errors],
                      ["Procurement events that will be recorded", report.counts.events],
                    ] as const
                  ).map(([label, n]) => (
                    <tr className="row" key={label}><td>{label}</td><td className="num mono">{n}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hd"><h3>Issues</h3><span className="note" style={{ margin: "0 0 0 auto" }}>{report.issues.length === 0 ? "None" : plural(report.issues.length, "issue")}</span></div>
            {groups.length === 0 ? (
              <p className="note" style={{ textAlign: "left", padding: "0 16px 14px", margin: 0 }}>Nothing to fix or check.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: "0 0 8px" }}>
                {groups.map(([code, g]) => (
                  <li key={code} style={{ borderTop: "1px solid var(--border)" }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ width: "100%", textAlign: "left", display: "flex", gap: 8, alignItems: "center", padding: "8px 16px" }}
                      aria-expanded={open.has(code)}
                      onClick={() => toggle(code)}
                    >
                      <span aria-hidden>{open.has(code) ? "▾" : "▸"}</span>
                      <span className={`chip ${CHIP[g.severity]}`}><i />{WORD[g.severity]}</span>
                      <span>{g.title}</span>
                      <span className="mono" style={{ marginLeft: "auto" }}>{g.issues.length}</span>
                    </button>
                    {open.has(code) && (
                      <ul style={{ margin: 0, padding: "0 16px 10px 40px", listStyle: "none", display: "grid", gap: 4, fontSize: "var(--fs-sm, 12px)" }}>
                        {g.issues.map((i, n) => (
                          <li key={n}>
                            {i.row != null && <span className="mono" style={{ color: "var(--muted)" }}>row {i.row} </span>}
                            {i.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="note" style={{ textAlign: "left", padding: "0 16px 12px", margin: 0 }}>
              {(["ERROR", "WARNING", "INFO"] as const).map((s) => `${SEVERITY_LABEL[s]} ${report.issues.filter((i) => i.severity === s).length}`).join(" · ")}
            </p>
          </div>

          <details className="card" style={{ marginBottom: 14, padding: "10px 16px" }}>
            <summary style={{ cursor: "pointer", fontSize: "var(--fs-md, 13px)" }}>{plural(report.items.length, "item")} in this file</summary>
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table>
                <thead><tr><th>Block</th><th className="num">Item</th><th>Part</th><th className="num">Qty</th><th>What happens</th><th className="num">Events</th></tr></thead>
                <tbody>
                  {report.items.slice(0, SHOW_FIRST).map((i) => (
                    <tr className="row" key={`${i.blockNo}-${i.row}`}>
                      <td className="mono">{i.blockNo}</td>
                      <td className="num mono">{i.itemNo}</td>
                      <td>{i.partName}</td>
                      <td className="num mono">{i.qty}{i.unit ? ` ${i.unit}` : ""}</td>
                      <td>{ACTION_LABEL[i.action]}</td>
                      <td className="num mono">{i.events}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.items.length > SHOW_FIRST && <p className="note" style={{ textAlign: "left" }}>First {SHOW_FIRST} shown.</p>}
            </div>
          </details>

          {blocked && <p className="note" style={{ textAlign: "left", margin: "0 0 12px" }}>{blocked}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={() => void pick(null)}>Cancel</button>
            <button type="button" className="btn btn-accent" disabled={blocked != null || applying} onClick={() => setConfirmOpen(true)}>
              Load {plural(report.counts.create, "item")}
            </button>
          </div>

          {confirmOpen && (
            <Modal
              open
              onOpenChange={(o) => !o && !applying && setConfirmOpen(false)}
              title="Load into the job?"
              footer={<ModalConfirmFooter onCancel={() => setConfirmOpen(false)} onConfirm={load} confirmLabel={applying ? "Loading…" : "Load"} disabled={applying} />}
            >
              <div style={{ display: "grid", gap: 10, fontSize: "var(--fs-md, 13px)" }}>
                <p style={{ margin: 0 }}>
                  This adds {plural(report.counts.create, "BOM item")} and {plural(report.counts.events, "procurement event")} to {target.jobNumber}
                  {Object.values(choices).filter((c) => "newName" in c).length > 0 ? `, and creates ${plural(Object.values(choices).filter((c) => "newName" in c).length, "equipment", "equipment")}` : ""}.
                </p>
                <p style={{ margin: 0, color: "var(--muted)" }}>It is written as you, in one step, and recorded in the audit log. Loading the same file again changes nothing.</p>
              </div>
            </Modal>
          )}
        </>
      )}

      {applied && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="hd"><h3>Loaded</h3></div>
          <div style={{ padding: "0 16px 16px", display: "grid", gap: 10, fontSize: "var(--fs-md, 13px)" }}>
            <p style={{ margin: 0 }}>
              {plural(applied.written.items, "BOM item")}, {plural(applied.written.events, "procurement event")}
              {applied.written.equipment ? ` and ${plural(applied.written.equipment, "new equipment", "new equipment")}` : ""} are now in {target.jobNumber}.
              {applied.counts.errors + applied.counts.conflict > 0 ? ` ${plural(applied.counts.errors + applied.counts.conflict, "item")} could not be loaded; fix them in Excel and load the file again.` : ""}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link className="btn btn-accent" href={`/jobs/${target.jobId}?tab=materials&view=parts`}>See the BOM</Link>
              <Link className="btn" href={`/jobs/${target.jobId}?tab=materials`}>Materials pipeline</Link>
              <button type="button" className="btn" onClick={() => void pick(null)}>Load another file</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
