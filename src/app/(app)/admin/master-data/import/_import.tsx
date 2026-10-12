"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import { PageHeader } from "@/components/industrial/page-header";
import { applyMasterImportAction, previewMasterImportAction, type ApplyMasterImportResult } from "@/app/actions/master-import";
import type { DryRunReport } from "@/lib/services/master-import.service";
import { checkWorkbookUpload } from "@/lib/shared/upload";
import {
  confirmBlockedReason, groupIssues, issuesToCsv, noPartLoads, severityCounts, whatWillLoad, type Severity,
} from "./_import-model";

const SHOW_FIRST = 50;
const SEVERITY_LABEL: Record<Severity, string> = { ERROR: "Errors", WARNING: "To check", INFO: "Notes" };
const HE_OUTCOME: Record<string, string> = {
  create: "new draft stage list",
  update: "draft stage list updated",
  unchanged: "unchanged",
};

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const sentence = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function heLabel(plan: DryRunReport["plan"]): string {
  const h = plan.heStages;
  if (h.stages === 0) return "none in this file";
  if (!h.loadable) return "not loadable (errors in the sheet)";
  return HE_OUTCOME[h.outcome] ?? h.outcome;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function MasterImport({ canApply, isHead, sections }: { canApply: boolean; isHead: boolean; sections?: ReactNode }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [allowDraft, setAllowDraft] = useState(true);
  const [report, setReport] = useState<DryRunReport | null>(null);
  const [applied, setApplied] = useState<ApplyMasterImportResult | null>(null);
  const [banner, setBanner] = useState<{ text: string; recheck: boolean } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [severity, setSeverity] = useState<Set<Severity>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [checking, startChecking] = useTransition();
  const [applying, startApplying] = useTransition();

  const reset = () => {
    setReport(null);
    setApplied(null);
    setBanner(null);
    setExpanded(new Set());
    setShowAll(new Set());
    setSeverity(new Set());
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
    fd.set("allowDraft", allowDraft ? "1" : "0");
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  };

  const check = () =>
    startChecking(async () => {
      setBanner(null);
      setApplied(null);
      const r = await previewMasterImportAction(formFor());
      if (r.ok && r.report) {
        setReport(r.report);
        setExpanded(new Set());
        setShowAll(new Set());
        return;
      }
      setReport(null);
      const reason = (r.ok ? undefined : (r.detail as { reason?: string } | undefined)?.reason) ?? (r.ok ? "" : r.message);
      setBanner({ text: reason, recheck: false });
    });

  const load = () =>
    startApplying(async () => {
      if (!report) return;
      const r = await applyMasterImportAction(
        formFor({ fileSha256: report.fileSha256, planFingerprint: report.planFingerprint }),
      );
      setConfirmOpen(false);
      if (r.ok) {
        setApplied(r);
        toast.success("Loaded into the tracker.");
        return;
      }
      const d = r.detail as { kind?: string; reason?: string } | undefined;
      if (d?.kind === "PLAN_CHANGED") setBanner({ text: "Master data changed since your check. Nothing was saved.", recheck: true });
      else if (d?.kind === "FILE_CHANGED") setBanner({ text: "This file changed after you checked it. Check it again.", recheck: true });
      else setBanner({ text: d?.reason ?? r.message, recheck: false });
    });

  const blocked = report ? confirmBlockedReason({ report, canApply, isHead }) : null;
  const counts = report ? severityCounts(report.issues) : null;
  const groups = report ? groupIssues(report.issues, severity) : [];
  const toggleIn = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };
  const approvedLoading = report ? report.parts.filter((p) => p.status === "APPROVED" && p.outcome !== "skipped").length : 0;

  return (
    <>
      <PageHeader title="Master data" subtitle="Import the Standard Parts Master" />
      {sections}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Workbook</h3></div>
        <div style={{ padding: "0 16px 16px", display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
            Choose the Excel workbook (.xlsx, up to 4 MB)
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label="Standard Parts Master workbook"
              onChange={(e) => void pick(e.target.files?.[0] ?? null)}
            />
          </label>
          {fileProblem && (
            <p role="alert" style={{ margin: 0, color: "var(--s-overdue)", fontSize: 13 }}>{fileProblem}</p>
          )}
          {file && (
            <p style={{ margin: 0, fontSize: 13 }}>
              <span className="mono">{file.name}</span> · {kb(file.size)}
            </p>
          )}
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={allowDraft}
              onChange={(e) => {
                setAllowDraft(e.target.checked);
                reset(); // the plan depends on it, so the old check no longer applies
              }}
            />
            <span>
              Load parts that are not approved yet as drafts
              <span style={{ display: "block", color: "var(--muted)" }}>
                Drafts are never used by a job until the Production Head approves them. Without this, only parts marked
                &ldquo;Approved by Production Head&rdquo; load.
              </span>
            </span>
          </label>
          <div>
            <button type="button" className="btn btn-accent" disabled={!file || checking} onClick={check}>
              {checking ? "Checking…" : "Check file"}
            </button>
          </div>
        </div>
      </div>

      {banner && (
        <div role="alert" className="card" style={{ marginBottom: 14, padding: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="chip c-overdue"><i />{banner.text}</span>
          {banner.recheck && (
            <button type="button" className="btn" onClick={check} disabled={checking || !file}>
              Check again
            </button>
          )}
        </div>
      )}

      {report && !applied && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hd">
              <h3>What this file would do</h3>
              <span className="note" style={{ margin: "0 0 0 auto" }}>
                Read {report.counts.parts} parts · {report.counts.routeSteps} route steps · {report.counts.materialGrades} materials ·{" "}
                {report.counts.heStages} heat-exchanger stages
              </span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th />
                    <th className="num">New</th>
                    <th className="num">Changed</th>
                    <th className="num">Already there</th>
                    <th className="num">Skipped</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["Part families", report.plan.partFamilies],
                      ["Routes", report.plan.routes],
                      ["Material grades", report.plan.materialGrades],
                    ] as const
                  ).map(([label, t]) => (
                    <tr className="row" key={label}>
                      <td>{label}</td>
                      <td className="num mono">{t.create}</td>
                      <td className="num mono">{t.update}</td>
                      <td className="num mono">{t.unchanged}</td>
                      <td className="num mono">{t.skipped}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ textAlign: "left", padding: "10px 16px 14px", margin: 0 }}>
              Stage mappings: <span className="mono">{report.plan.stageMappingRows}</span> rows · Heat-exchanger stage list: {heLabel(report.plan)}
            </p>
          </div>

          {noPartLoads(report) && (
            <div className="card" style={{ marginBottom: 14, padding: 12, fontSize: 13 }}>
              No part will load: none is marked &ldquo;Approved by Production Head&rdquo;.{" "}
              {whatWillLoad(report.plan) !== "nothing"
                ? `Still loads: ${whatWillLoad(report.plan)}, as drafts. Tick “Load parts that are not approved yet as drafts” to load the parts too.`
                : "Tick “Load parts that are not approved yet as drafts” to load them."}
            </div>
          )}

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hd" style={{ gap: 8, flexWrap: "wrap" }}>
              <h3>Issues</h3>
              {counts && (["ERROR", "WARNING", "INFO"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={severity.has(s) ? "btn btn-outline-accent" : "btn"}
                  aria-pressed={severity.has(s)}
                  onClick={() => setSeverity((cur) => toggleIn(cur, s))}
                >
                  {SEVERITY_LABEL[s]} <span className="mono">{counts[s]}</span>
                </button>
              ))}
              <button
                type="button"
                className="btn"
                style={{ marginLeft: "auto" }}
                disabled={report.issues.length === 0}
                onClick={() => download("master-data-issues.csv", issuesToCsv(report.issues))}
              >
                Download issues (CSV)
              </button>
            </div>
            {groups.length === 0 ? (
              <p className="note" style={{ textAlign: "left", padding: "0 16px 14px", margin: 0 }}>
                {report.issues.length === 0 ? "Nothing to fix or check." : "No issues of that kind."}
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: "0 0 8px" }}>
                {groups.map((g) => {
                  const open = expanded.has(g.code);
                  const all = showAll.has(g.code);
                  const rows = all ? g.issues : g.issues.slice(0, SHOW_FIRST);
                  return (
                    <li key={g.code} style={{ borderTop: "1px solid var(--border)" }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ width: "100%", textAlign: "left", display: "flex", gap: 8, alignItems: "center", padding: "8px 16px" }}
                        aria-expanded={open}
                        onClick={() => setExpanded((cur) => toggleIn(cur, g.code))}
                      >
                        <span aria-hidden>{open ? "▾" : "▸"}</span>
                        <span className={`chip ${g.severity === "ERROR" ? "c-overdue" : g.severity === "WARNING" ? "c-hold" : "c-idle"}`}>
                          <i />
                          {g.severity === "ERROR" ? "Error" : g.severity === "WARNING" ? "Check" : "Note"}
                        </span>
                        <span>{g.title}</span>
                        <span className="mono" style={{ marginLeft: "auto" }}>{g.count}</span>
                      </button>
                      {open && (
                        <div style={{ padding: "0 16px 10px 40px", fontSize: 12 }}>
                          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
                            {rows.map((i, n) => (
                              <li key={n}>
                                <span className="mono" style={{ color: "var(--muted)" }}>
                                  {i.sheet}{i.row != null ? ` row ${i.row}` : ""}{i.partCode ? ` · ${i.partCode}` : ""}
                                </span>{" "}
                                {i.message}
                              </li>
                            ))}
                          </ul>
                          {!all && g.count > SHOW_FIRST && (
                            <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => setShowAll((cur) => toggleIn(cur, g.code))}>
                              Show all {g.count}
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <details className="card" style={{ marginBottom: 14, padding: "10px 16px" }}>
            <summary style={{ cursor: "pointer", fontSize: 13 }}>{sentence(report.parts.length, "part", "parts")} in this file</summary>
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table>
                <thead>
                  <tr><th>Part</th><th>Status in file</th><th>What happens</th><th>Routes</th></tr>
                </thead>
                <tbody>
                  {report.parts.map((p) => (
                    <tr className="row" key={p.code}>
                      <td className="mono"><Link href={`/admin/master-data?q=${encodeURIComponent(p.code)}`}>{p.code}</Link></td>
                      <td>{p.status === "APPROVED" ? "Approved" : p.status === "REVIEWED" ? "Reviewed" : "Draft"}</td>
                      <td>{{ create: "New", update: "Changed", unchanged: "Already there", skipped: "Skipped" }[p.outcome]}</td>
                      <td className="mono">{p.routes.map((r) => `${r.variant}: ${r.steps} steps ${r.outcome}`).join(" · ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <p className="note" style={{ textAlign: "left", margin: "0 0 12px" }}>
            Operation names are matched with a list the Production Head has not confirmed yet. Rows with errors are skipped; nothing half-loads.
          </p>

          {blocked && <p className="note" style={{ textAlign: "left", margin: "0 0 12px" }}>{blocked}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={reset}>Cancel</button>
            <button type="button" className="btn btn-accent" disabled={blocked != null || applying} onClick={() => setConfirmOpen(true)}>
              {noPartLoads(report) && whatWillLoad(report.plan) !== "nothing" ? `Load ${whatWillLoad(report.plan)}` : "Load into tracker"}
            </button>
          </div>

          {confirmOpen && (
            <Modal
              open
              onOpenChange={(o) => !o && !applying && setConfirmOpen(false)}
              title="Load into the tracker?"
              footer={
                <ModalConfirmFooter
                  onCancel={() => setConfirmOpen(false)}
                  onConfirm={load}
                  confirmLabel={applying ? "Loading…" : "Load"}
                  disabled={applying}
                />
              }
            >
              <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
                <p style={{ margin: 0 }}>This loads {whatWillLoad(report.plan)}.</p>
                {approvedLoading > 0 && (
                  <p style={{ margin: 0 }}>
                    {sentence(approvedLoading, "part", "parts")} marked &ldquo;Approved by Production Head&rdquo; load as approved, and
                    their routes are published for new jobs.
                  </p>
                )}
                {allowDraft && (
                  <p style={{ margin: 0, color: "var(--muted)" }}>
                    Parts not marked approved load as drafts and are not used by any job until they are approved.
                  </p>
                )}
                <p style={{ margin: 0, color: "var(--muted)" }}>Loading the same file again changes nothing.</p>
              </div>
            </Modal>
          )}
        </>
      )}

      {applied && applied.ok && applied.written && applied.plan && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="hd"><h3>Loaded</h3></div>
          <div style={{ padding: "0 16px 16px", display: "grid", gap: 10, fontSize: 13 }}>
            <p style={{ margin: 0 }}>
              Part families: planned {applied.plan.partFamilies.create + applied.plan.partFamilies.update}, written{" "}
              {applied.written.partFamilies.create + applied.written.partFamilies.update} · Routes: planned{" "}
              {applied.plan.routes.create + applied.plan.routes.update}, written {applied.written.routes.create + applied.written.routes.update}{" "}
              · Material grades: planned {applied.plan.materialGrades.create + applied.plan.materialGrades.update}, written{" "}
              {applied.written.materialGrades.create + applied.written.materialGrades.update} · Stage mappings written{" "}
              {applied.written.stageMappingRows} · Heat-exchanger stage list: {applied.written.heTemplate}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link className="btn btn-accent" href="/admin/master-data?status=DRAFT">Review the draft parts</Link>
              <Link className="btn" href="/admin/master-data?issues=1">Parts with problems</Link>
              <Link className="btn" href="/admin/master-data/materials?status=DRAFT">Draft material grades</Link>
              <button type="button" className="btn" onClick={() => { reset(); void pick(null); }}>Import another file</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
