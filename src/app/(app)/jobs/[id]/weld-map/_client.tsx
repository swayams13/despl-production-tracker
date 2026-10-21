"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import { PageHeader } from "@/components/industrial/page-header";
import { addJointsFromTagsAction, applyWeldMapAction, confirmWeldMapAction, previewWeldMapAction } from "@/app/actions/weld-map";
import type { WeldMapLine, WeldMapReport, WeldMapView } from "@/lib/services/weld-map.service";
import type { Severity } from "@/lib/shared/job-import";
import { checkWorkbookUpload } from "@/lib/shared/upload";
import { JOINT_TYPE_LABEL, jointsFromTags, type TagMode } from "@/lib/shared/weld-map";

/**
 * Lean Core J4b (frame 14C). One line at a time: its joints and whether each is confirmed,
 * then the three ways to add to the map. The BOM release uses every joint on the map; the
 * unconfirmed ones are flagged here until QC or Engineering confirms them.
 */

const SHOW_FIRST = 100;
const ACTION_LABEL = { ADD: "Will add", UPDATE: "Will update", SAME: "No change", REFUSED: "Refused" } as const;
const CHIP: Record<Severity, string> = { ERROR: "c-overdue", WARNING: "c-hold", INFO: "c-idle" };
const WORD: Record<Severity, string> = { ERROR: "Error", WARNING: "Check", INFO: "Note" };
const FIELD: Record<string, string> = { jointType: "type", joins: "joins", wpsRef: "WPS", ndtExtent: "NDT extent" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function reasonOf(r: { ok: false; message: string; detail?: Record<string, unknown> }): string {
  const reason = r.detail?.reason;
  return typeof reason === "string" ? reason : r.message;
}

export function WeldMapClient({ view, initialLineId }: { view: WeldMapView; initialLineId: number | null }) {
  const [lineId, setLineId] = useState(view.lines.find((l) => l.id === initialLineId)?.id ?? view.lines[0]?.id ?? null);
  const line = view.lines.find((l) => l.id === lineId) ?? null;

  return (
    <>
      <PageHeader title="Weld map" subtitle={`${view.job.jobNumber}${view.job.projectName ? ` · ${view.job.projectName}` : ""}`} />
      <p className="note" style={{ textAlign: "left", margin: "0 0 12px" }}>
        The welded joints of each line. Weld, fit-up and NDT steps are made from these joints when the BOM is released.{" "}
        <Link href={`/jobs/${view.job.id}?tab=materials&view=parts`}>Back to Materials</Link>
      </p>
      {view.lines.length === 0 || !line ? (
        <p className="note" style={{ textAlign: "left" }}>This job has no equipment lines yet.</p>
      ) : (
        <>
          {view.lines.length > 1 && (
            <div className="jt-sub" role="group" aria-label="Line" style={{ marginBottom: 12 }}>
              {view.lines.map((l) => (
                <button key={l.id} type="button" className={`btn${l.id === line.id ? " jt-on" : ""}`} aria-pressed={l.id === line.id} onClick={() => setLineId(l.id)}>
                  {l.name}
                </button>
              ))}
            </div>
          )}
          <Register key={line.id} view={view} line={line} />
        </>
      )}
    </>
  );
}

function Register({ view, line }: { view: WeldMapView; line: WeldMapLine }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const unconfirmed = line.joints.filter((j) => !j.confirmed);

  const confirmAll = () =>
    start(async () => {
      const r = await confirmWeldMapAction(view.job.id, line.id);
      if (!r.ok) return void toast.error(reasonOf(r));
      toast.success(r.confirmed?.length ? `Confirmed ${plural(r.confirmed.length, "joint")}.` : "Nothing to confirm.");
      router.refresh();
    });

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>{line.name}</h3>
          <span className="note" style={{ margin: "0 0 0 auto" }}>
            {plural(line.joints.length, "joint")} · {line.joints.length - unconfirmed.length} confirmed · {unconfirmed.length} not confirmed · {plural(line.units, "unit")}
          </span>
        </div>
        {line.notices.map((n) => (
          <p key={n} role="status" className="note" style={{ textAlign: "left", margin: "0 16px 8px" }}>
            <span className="chip c-hold"><i />{n}</span>
          </p>
        ))}
        {line.joints.length === 0 ? (
          <p className="note" style={{ textAlign: "left", padding: "0 16px 14px", margin: 0 }}>
            No joints on this line&apos;s weld map yet.{view.canEdit ? " Add joints from a list or load an Excel weld map below." : ""}
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Joint</th><th>Type</th><th>Joins</th><th>WPS</th><th>NDT extent</th><th>Status</th><th className="num">Steps</th><th className="num">Weld records</th></tr>
              </thead>
              <tbody>
                {line.joints.map((j) => (
                  <tr className="row" key={j.id}>
                    <td className="mono">{j.jointNo}</td>
                    <td>{JOINT_TYPE_LABEL[j.jointType]}</td>
                    <td>{j.joins ?? <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td className="mono">{j.wpsRef ?? <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td>{j.ndtExtent ?? <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td>
                      {j.confirmed ? <span className="chip c-complete"><i />Confirmed</span> : <span className="chip c-progress"><i />{j.source === "GENERATED" ? "Generated, not confirmed" : "Not confirmed"}</span>}
                    </td>
                    <td className="num mono">{j.steps}</td>
                    <td className="num mono">{j.welds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note" style={{ textAlign: "left", padding: "8px 16px 12px", margin: 0 }}>
          Steps follow at BOM release: joints added now do not create steps on units that already have them. Not-confirmed joints still count at release; they are flagged until checked.
        </p>
        {unconfirmed.length > 0 && (
          <div style={{ padding: "0 16px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {view.canConfirm ? (
              <button type="button" className="btn btn-accent" disabled={pending} onClick={confirmAll}>
                {pending ? "Confirming…" : `Confirm ${plural(unconfirmed.length, "joint")}`}
              </button>
            ) : (
              <span className="note" style={{ margin: 0 }}>QC or Engineering confirms joints after checking them against the weld map.</span>
            )}
          </div>
        )}
      </div>

      {view.canEdit ? (
        <>
          <AddFromList view={view} line={line} />
          <LoadWorkbook view={view} line={line} />
        </>
      ) : (
        <p className="note" style={{ textAlign: "left" }}>Engineering, the Production Head and Admins can change the weld map.</p>
      )}
    </>
  );
}

function AddFromList({ view, line }: { view: WeldMapView; line: WeldMapLine }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<TagMode>("NOZZLES");
  const [flanges, setFlanges] = useState(true);
  const [text, setText] = useState("");
  const have = useMemo(() => new Set(line.joints.map((j) => j.jointNo)), [line.joints]);
  const preview = useMemo(() => (text.trim() ? jointsFromTags(text, mode, flanges) : null), [text, mode, flanges]);
  const fresh = preview?.joints.filter((j) => !have.has(j.jointNo)) ?? [];
  const there = preview?.joints.filter((j) => have.has(j.jointNo)) ?? [];

  const add = () =>
    start(async () => {
      const r = await addJointsFromTagsAction(view.job.id, line.id, text, mode, flanges);
      if (!r.ok) return void toast.error(reasonOf(r));
      toast.success(r.added?.length ? `Added ${plural(r.added.length, "joint")}.` : "Those joints are already on the map.");
      setText("");
      router.refresh();
    });

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="hd"><h3>Add joints from a list</h3></div>
      <div style={{ padding: "0 16px 16px", display: "grid", gap: 10, fontSize: "var(--fs-md, 13px)" }}>
        <label style={{ display: "grid", gap: 6 }}>
          The list names
          <select className="ws-detail" value={mode} onChange={(e) => setMode(e.target.value as TagMode)} aria-label="What the list names">
            <option value="NOZZLES">Nozzle tags (N1-N6, M1): adds the nozzle welds</option>
            <option value="JOINTS">Joint numbers (SK-1, GW-1…GW-32): added as typed</option>
          </select>
        </label>
        {mode === "NOZZLES" && (
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={flanges} onChange={(e) => setFlanges(e.target.checked)} />
            Also add the nozzle-to-flange weld (NF-) for each tag
          </label>
        )}
        <label style={{ display: "grid", gap: 6 }}>
          {mode === "NOZZLES" ? "Nozzle tags" : "Joint numbers"}
          <textarea
            className="ws-detail"
            rows={2}
            maxLength={4000}
            value={text}
            placeholder={mode === "NOZZLES" ? "N1-N6, M1" : "SK-1, BR-SK, GW-1…GW-32"}
            onChange={(e) => setText(e.target.value)}
            aria-label="Tags or joint numbers"
          />
        </label>
        {preview && preview.errors.length > 0 && <p role="alert" style={{ margin: 0, color: "var(--s-overdue)" }}>{preview.errors.join(" ")}</p>}
        {preview && preview.errors.length === 0 && (
          <p style={{ margin: 0 }} aria-live="polite">
            Will add <b>{fresh.length}</b>
            {fresh.length > 0 && <>: <span className="mono">{fresh.length > 8 ? `${fresh.slice(0, 8).map((j) => j.jointNo).join(", ")} … ${fresh[fresh.length - 1].jointNo}` : fresh.map((j) => j.jointNo).join(", ")}</span></>}.
            {there.length > 0 && <> Already on the map: {there.length}.</>} They start as not confirmed.
          </p>
        )}
        <div>
          <button type="button" className="btn btn-accent" disabled={pending || fresh.length === 0 || (preview?.errors.length ?? 0) > 0} onClick={add}>
            {pending ? "Adding…" : fresh.length ? `Add ${plural(fresh.length, "joint")}` : "Add joints"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LoadWorkbook({ view, line }: { view: WeldMapView; line: WeldMapLine }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [report, setReport] = useState<WeldMapReport | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checking, startChecking] = useTransition();
  const [applying, startApplying] = useTransition();

  const pick = async (f: File | null) => {
    setReport(null);
    setBanner(null);
    setFile(null);
    setFileProblem(null);
    if (!f) return;
    const problem = checkWorkbookUpload({ name: f.name, size: f.size, head: new Uint8Array(await f.slice(0, 4).arrayBuffer()) });
    if (problem) setFileProblem(problem);
    else setFile(f);
  };
  const formFor = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("file", file as File);
    fd.set("jobId", String(view.job.id));
    fd.set("equipmentId", String(line.id));
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  };
  const check = () =>
    startChecking(async () => {
      setBanner(null);
      const r = await previewWeldMapAction(formFor());
      if (r.ok && r.report) return void setReport(r.report);
      setReport(null);
      setBanner(r.ok ? "Could not read that file." : reasonOf(r));
    });
  const load = () =>
    startApplying(async () => {
      if (!report) return;
      const r = await applyWeldMapAction(formFor({ fileSha256: report.fileSha256, planFingerprint: report.planFingerprint }));
      setConfirmOpen(false);
      if (r.ok && r.applied) {
        toast.success(`Loaded: ${plural(r.applied.added, "joint")} added, ${r.applied.updated} updated.`);
        void pick(null);
        router.refresh();
        return;
      }
      setBanner(r.ok ? "Nothing was loaded." : reasonOf(r));
    });

  const refused = report?.rows.filter((r) => r.action === "REFUSED") ?? [];
  const errors = report?.issues.filter((i) => i.severity === "ERROR").length ?? 0;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="hd"><h3>Load an Excel weld map</h3></div>
      <div style={{ padding: "0 16px 16px", display: "grid", gap: 12, fontSize: "var(--fs-md, 13px)" }}>
        <p className="note" style={{ textAlign: "left", margin: 0 }}>
          One row per joint. Columns, in any order: Joint no, Type (optional), Joins, WPS, NDT extent, Remarks. Loading the same file again changes nothing, and a joint missing from the file is never removed.
        </p>
        <label style={{ display: "grid", gap: 6 }}>
          Choose the Excel file (.xlsx, up to 4 MB)
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Weld map file" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
        </label>
        {fileProblem && <p role="alert" style={{ margin: 0, color: "var(--s-overdue)" }}>{fileProblem}</p>}
        {file && <p style={{ margin: 0 }}><span className="mono">{file.name}</span> · {kb(file.size)}</p>}
        <div>
          <button type="button" className="btn btn-accent" disabled={!file || checking} onClick={check}>
            {checking ? "Checking…" : report ? "Check again" : "Check file"}
          </button>
        </div>
        {banner && <div role="alert"><span className="chip c-overdue"><i />{banner}</span></div>}

        {report && (
          <>
            <table>
              <tbody>
                {(
                  [
                    ["Joints to add", report.counts.add],
                    ["Joints to update", report.counts.update],
                    ["No change", report.counts.same],
                    ["Refused", report.counts.refused],
                    ["On the map, not in this file (kept)", report.counts.notInFile],
                    ["Rows with errors (not loaded)", errors],
                  ] as const
                ).map(([label, n]) => (
                  <tr className="row" key={label}><td>{label}</td><td className="num mono">{n}</td></tr>
                ))}
              </tbody>
            </table>

            {refused.map((r) => (
              <p key={r.jointNo} role="alert" style={{ margin: 0 }}><span className="chip c-overdue"><i />Refused</span> {r.reason}</p>
            ))}
            {report.issues.length > 0 && (
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4, fontSize: "var(--fs-sm, 12px)" }}>
                {report.issues.map((i, n) => (
                  <li key={n}>
                    <span className={`chip ${CHIP[i.severity]}`}><i />{WORD[i.severity]}</span>{" "}
                    {i.row != null && <span className="mono" style={{ color: "var(--muted)" }}>row {i.row} </span>}
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary style={{ cursor: "pointer" }}>{plural(report.rows.length, "joint")} in this file</summary>
              <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table>
                  <thead><tr><th className="num">Row</th><th>Joint</th><th>Type</th><th>What happens</th><th>Changes</th></tr></thead>
                  <tbody>
                    {report.rows.slice(0, SHOW_FIRST).map((r) => (
                      <tr className="row" key={r.jointNo}>
                        <td className="num mono">{r.row}</td>
                        <td className="mono">{r.jointNo}</td>
                        <td>{JOINT_TYPE_LABEL[r.jointType]}</td>
                        <td>{ACTION_LABEL[r.action]}{r.unconfirms ? " (confirm again)" : ""}</td>
                        <td>{r.changes.map((c) => FIELD[c.field]).join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.rows.length > SHOW_FIRST && <p className="note" style={{ textAlign: "left" }}>First {SHOW_FIRST} shown.</p>}
              </div>
            </details>
            {report.notInFile.length > 0 && (
              <p className="note" style={{ textAlign: "left", margin: 0 }}>
                Not in this file, left as they are: <span className="mono">{report.notInFile.slice(0, 20).join(", ")}{report.notInFile.length > 20 ? " …" : ""}</span>
              </p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn" onClick={() => void pick(null)}>Cancel</button>
              <button type="button" className="btn btn-accent" disabled={!report.canApply || applying} onClick={() => setConfirmOpen(true)}>
                Load {plural(report.counts.add + report.counts.update, "joint")}
              </button>
            </div>
            {!report.canApply && <p className="note" style={{ textAlign: "left", margin: 0 }}>{report.counts.refused > 0 ? "Fix the refused joints in the file and check it again." : "There is nothing to load."}</p>}
            {confirmOpen && (
              <Modal
                open
                onOpenChange={(o) => !o && !applying && setConfirmOpen(false)}
                title="Load into the weld map?"
                footer={<ModalConfirmFooter onCancel={() => setConfirmOpen(false)} onConfirm={load} confirmLabel={applying ? "Loading…" : "Load"} disabled={applying} />}
              >
                <div style={{ display: "grid", gap: 10 }}>
                  <p style={{ margin: 0 }}>
                    This adds {plural(report.counts.add, "joint")} and updates {report.counts.update} on {line.name}. New joints start as not confirmed.
                    {report.rows.some((r) => r.unconfirms) ? " A joint that was confirmed and changes needs confirming again." : ""}
                  </p>
                  <p style={{ margin: 0, color: "var(--muted)" }}>It is written as you, in one step, and recorded in the audit log. Nothing is deleted.</p>
                </div>
              </Modal>
            )}
          </>
        )}
      </div>
    </div>
  );
}
