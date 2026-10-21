"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import {
  checkAssemblySequenceAction,
  importAssemblySequenceAction,
  publishAssemblyTemplateVersionAction,
} from "@/app/actions/assembly-template";
import type { AssemblySequenceReport, AssemblyVersionView, SequenceOutcome } from "@/lib/services/assembly-template.service";
import { checkWorkbookUpload } from "@/lib/shared/upload";

export type AssemblyTypeOption = { id: number; code: string; name: string; versions: AssemblyVersionView[] };

const humanize = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const ROLE_LABEL: Record<string, string> = { FIT_UP: "Fit-up", WELD: "Weld", NDT: "NDT", HEAT_TREATMENT: "Heat treatment", FINAL_PWHT: "Final PWHT", HYDRO: "Hydro test" };
const STATUS_CHIP: Record<string, string> = { PUBLISHED: "c-complete", DRAFT: "c-hold", ARCHIVED: "c-idle" };
const OUTCOME_TEXT: Record<SequenceOutcome, string> = {
  NEW_DRAFT: "Importing will create a new draft version.",
  UPDATE_DRAFT: "Importing will replace the steps of the draft already waiting for approval.",
  UNCHANGED_DRAFT: "This is the same as the draft already waiting for approval. Nothing to import.",
  UNCHANGED_PUBLISHED: "This is the same as the published version. Nothing to import.",
};
const when = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : "");
const scopeText = (scope: string, jointType: string | null) => (scope === "PER_JOINT" ? `Each ${(jointType ? humanize(jointType) : "joint").toLowerCase()} joint` : "Each unit");

function StepTable({ steps }: { steps: Array<{ seq: number; groupCode: string; srNo: string; activity: string; kind: string; leadTimeProcessSeq: number | null; scope: string; jointType: string | null; role: string | null; pressurePart: boolean; department?: string; defaultDepartmentId?: number }> }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Group</th>
            <th>Step</th>
            <th>Activity</th>
            <th>Kind</th>
            <th>Department</th>
            <th className="num">Stage</th>
            <th>Applies to</th>
            <th>Role (inferred)</th>
            <th>Pressure part</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr className="row" key={s.seq}>
              <td className="num mono">{s.seq}</td>
              <td className="mono">{s.groupCode}</td>
              <td className="mono">{s.srNo}</td>
              <td>{s.activity}</td>
              <td>{humanize(s.kind)}</td>
              <td>{s.department ?? ""}</td>
              <td className="num mono">{s.leadTimeProcessSeq ?? "—"}</td>
              <td>{scopeText(s.scope, s.jointType)}</td>
              <td>{s.role ? (ROLE_LABEL[s.role] ?? humanize(s.role)) : "—"}</td>
              <td>{s.pressurePart ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AssemblySequenceSection({
  types,
  isHead,
  currentUserId,
  departmentNames,
}: {
  types: AssemblyTypeOption[];
  isHead: boolean;
  currentUserId: number;
  departmentNames: Record<number, string>;
}) {
  const router = useRouter();
  const [typeId, setTypeId] = useState<number | null>(types[0]?.id ?? null);
  const [shown, setShown] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [report, setReport] = useState<AssemblySequenceReport | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<AssemblyVersionView | null>(null);
  const [checking, startChecking] = useTransition();
  const [importing, startImporting] = useTransition();
  const [publishPending, startPublish] = useTransition();

  const type = types.find((t) => t.id === typeId) ?? null;
  const shownVersion = type?.versions.find((v) => v.id === shown) ?? null;

  const reset = () => {
    setReport(null);
    setBanner(null);
  };
  const form = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("file", file as File);
    fd.set("equipmentTypeId", String(typeId));
    if (label) fd.set("label", label);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  };
  const reasonOf = (r: { message: string; detail?: Record<string, unknown> }) => (typeof r.detail?.reason === "string" ? r.detail.reason : r.message);

  const pick = async (f: File | null) => {
    reset();
    setLabel("");
    setFile(null);
    setFileProblem(null);
    if (!f) return;
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    const problem = checkWorkbookUpload({ name: f.name, size: f.size, head });
    if (problem) setFileProblem(problem);
    else setFile(f);
  };

  const check = (chosen = label) =>
    startChecking(async () => {
      setBanner(null);
      const fd = form();
      if (chosen) fd.set("label", chosen);
      const r = await checkAssemblySequenceAction(fd);
      if (r.ok && r.report) {
        setReport(r.report);
        if (r.report.label) setLabel(r.report.label);
        return;
      }
      setReport(null);
      setBanner(r.ok ? "Could not read the workbook." : reasonOf(r));
    });

  const doImport = () =>
    startImporting(async () => {
      if (!report?.label) return;
      const r = await importAssemblySequenceAction(form({ label: report.label, planFingerprint: report.planFingerprint }));
      if (r.ok) {
        toast.success(r.imported?.version ? `Saved as draft version ${r.imported.version}. The Production Head can publish it.` : "Nothing to import.");
        reset();
        void pick(null);
        router.refresh();
        return;
      }
      setBanner(reasonOf(r));
    });

  const publish = () =>
    startPublish(async () => {
      if (!publishing) return;
      const r = await publishAssemblyTemplateVersionAction({ versionId: publishing.id });
      if (r.ok) {
        toast.success(`Version ${publishing.version} published. New jobs of this type use it.`);
        setPublishing(null);
        router.refresh();
        return;
      }
      toast.error(reasonOf(r));
      setPublishing(null);
    });

  const stepsWithDept = report?.steps.map((s) => ({ ...s, department: departmentNames[s.defaultDepartmentId] ?? "" })) ?? [];
  const canImport = !!report && report.errors === 0 && (report.outcome === "NEW_DRAFT" || report.outcome === "UPDATE_DRAFT");

  return (
    <section aria-labelledby="asm-seq-h" style={{ marginTop: 24 }}>
      <div className="page-h">
        <h2 id="asm-seq-h" style={{ margin: 0 }}>Assembly sequence</h2>
        <span className="sub">The steps a job of this type is built from. Import from the master workbook; the Production Head publishes.</span>
      </div>

      {types.length === 0 ? (
        <div className="card"><p className="note" style={{ padding: 16 }}>Add an equipment type above, then import its assembly sequence here.</p></div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hd" style={{ gap: 8, flexWrap: "wrap" }}>
              <h3>Versions</h3>
              <select className="ws-detail" aria-label="Equipment type" value={typeId ?? ""} onChange={(e) => { setTypeId(Number(e.target.value)); setShown(null); reset(); void pick(null); }}>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            {type && type.versions.length === 0 ? (
              <p className="note" style={{ padding: 16 }}>
                No sequence of its own yet: jobs of this type use the family&apos;s standard sequence. Import one below.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th className="num">Version</th>
                      <th>Status</th>
                      <th className="num">Steps</th>
                      <th>Imported by</th>
                      <th>Published by</th>
                      <th className="num">Lines using it</th>
                      <th className="num">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {type?.versions.map((v) => (
                      <tr className="row" key={v.id}>
                        <td className="num mono">{v.version}</td>
                        <td><span className={`chip ${STATUS_CHIP[v.status] ?? "c-idle"}`}><i />{humanize(v.status)}</span></td>
                        <td className="num mono">{v.steps.length}</td>
                        <td>{v.preparedByName ?? "—"}</td>
                        <td>{v.approvedByName ? `${v.approvedByName}, ${when(v.publishedAt)}` : v.publishedAt ? when(v.publishedAt) : "—"}</td>
                        <td className="num mono">{v.pinnedLines}</td>
                        <td className="num">
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                            <button className="btn" aria-pressed={shown === v.id} onClick={() => setShown(shown === v.id ? null : v.id)}>
                              {shown === v.id ? "Hide steps" : "View steps"}
                            </button>
                            {v.status === "DRAFT" && isHead && v.preparedById !== currentUserId && (
                              <button className="btn btn-accent" onClick={() => setPublishing(v)}>Publish</button>
                            )}
                            {v.status === "DRAFT" && v.preparedById === currentUserId && (
                              <span className="note" style={{ margin: 0 }}>Imported by you: another Production Head publishes</span>
                            )}
                            {v.status === "DRAFT" && !isHead && v.preparedById !== currentUserId && (
                              <span className="note" style={{ margin: 0 }}>Waiting for the Production Head</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {shownVersion && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="hd"><h3>Version {shownVersion.version} steps</h3></div>
              <StepTable steps={shownVersion.steps} />
            </div>
          )}

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hd"><h3>Import from the master workbook</h3></div>
            <div style={{ padding: "0 16px 16px", display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 6, fontSize: "var(--fs-md, 13px)" }}>
                Choose the Excel workbook (.xlsx, up to 4 MB). The &ldquo;Assembly Sequence&rdquo; sheet is read.
                <input type="file" accept=".xlsx" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
              </label>
              {fileProblem && <p role="alert" className="note" style={{ textAlign: "left", margin: 0 }}>{fileProblem}</p>}
              {report?.needsLabel && (
                <label style={{ display: "grid", gap: 6, fontSize: "var(--fs-md, 13px)" }}>
                  Which equipment type in the workbook is this?
                  <select className="ws-detail" value={label} onChange={(e) => { setLabel(e.target.value); if (e.target.value) check(e.target.value); }}>
                    <option value="">Choose…</option>
                    {report.labels.map((l) => <option key={l.label} value={l.label}>{l.label} ({l.rows} rows)</option>)}
                  </select>
                </label>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn" disabled={!file || checking} onClick={() => check()}>{checking ? "Checking…" : "Check the workbook"}</button>
              </div>
              {banner && <p role="alert" className="note" style={{ textAlign: "left", margin: 0 }}>{banner}</p>}
            </div>
          </div>

          {report && !report.needsLabel && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="hd" style={{ gap: 8, flexWrap: "wrap" }}>
                <h3>What this would load</h3>
                <span className="note" style={{ margin: "0 0 0 auto" }}>
                  {report.rowsRead} rows read · {report.steps.length} steps · {report.collapses.length} joint groups merged · {report.errors} errors
                </span>
              </div>
              <div style={{ padding: "0 16px 12px", display: "grid", gap: 10 }}>
                {report.outcome && <p style={{ margin: 0 }}>{OUTCOME_TEXT[report.outcome]}</p>}
                {report.issues.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {report.issues.map((i, k) => (
                      <li key={k}>
                        <strong>{i.severity === "ERROR" ? "Fix: " : i.severity === "WARNING" ? "Check: " : ""}</strong>
                        {i.row ? <span className="mono">Row {i.row}: </span> : null}
                        {i.message}
                      </li>
                    ))}
                  </ul>
                )}
                {report.collapses.length > 0 && (
                  <details>
                    <summary>Rows merged into one step per joint ({report.collapses.length})</summary>
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                      {report.collapses.map((c, k) => (
                        <li key={k}>{c.activity}: {c.jointRefs.join(", ")} (rows {c.rows.join(", ")})</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              {report.steps.length > 0 && <StepTable steps={stepsWithDept} />}
              <div style={{ padding: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button className="btn btn-accent" disabled={!canImport || importing} onClick={doImport}>
                  {importing ? "Importing…" : "Import as draft"}
                </button>
                {!canImport && <span className="note" style={{ margin: 0 }}>{report.errors > 0 ? "Fix the rows marked Fix in the workbook and check again." : "Nothing new to import."}</span>}
              </div>
            </div>
          )}
        </>
      )}

      <Modal
        open={publishing != null}
        onOpenChange={(o) => !o && setPublishing(null)}
        title={`Publish version ${publishing?.version ?? ""}?`}
        footer={<ModalConfirmFooter onCancel={() => setPublishing(null)} onConfirm={publish} confirmLabel="Publish" disabled={publishPending} />}
      >
        <p style={{ fontSize: "var(--fs-md, 13px)", margin: 0 }}>
          New jobs of {type?.name} will be built from these {publishing?.steps.length} steps. Jobs already running keep the version they have.
          A published version cannot be edited; a change arrives as a new version.
        </p>
        <p className="note" style={{ textAlign: "left" }}>
          Roles (fit-up, weld, NDT, heat treatment, hydro) and pressure flags came from the activity text. Check them in the step list first.
        </p>
      </Modal>
    </section>
  );
}
