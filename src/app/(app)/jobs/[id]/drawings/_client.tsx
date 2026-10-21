"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PageHeader } from "@/components/industrial/page-header";
import {
  createAssemblyDrawingAction,
  createDrawingRevisionAction,
  linkDrawingToComponentsAction,
  releaseDrawingAtRiskAction,
} from "@/app/actions/drawing";
import type { ActionResult } from "@/app/actions/_action";
import type { DrawingRegisterRow, DrawingsView } from "@/lib/services/drawings.read";

/**
 * Lean Core JG1. H3 stops pressure-part cutting until the drawing governing the part has a
 * released current revision (or the Production Head released it at risk). A part with no
 * drawing at all is not stopped, so the list at the bottom is the gap: link those parts.
 */

const STATE = {
  RELEASED: { label: "Released", cls: "c-complete" },
  AT_RISK: { label: "Released at risk", cls: "c-hold" },
  NOT_RELEASED: { label: "Not released", cls: "c-overdue" },
  NO_LINK: { label: "Not linked", cls: "c-idle" },
} as const;
const REV: Record<string, string> = { DRAFT: "Draft", SUBMITTED: "Submitted", RELEASED: "Released", SUPERSEDED: "Superseded" };
const fmt = (d: Date | string) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function DrawingsClient({ view }: { view: DrawingsView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, ok: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.message);
      toast.success(ok);
      after?.();
      router.refresh();
    });
  const jobId = view.job.id;

  return (
    <>
      <PageHeader title="Drawings" subtitle={`${view.job.jobNumber}${view.job.projectName ? ` · ${view.job.projectName}` : ""}`} />
      <p className="note" style={{ textAlign: "left", margin: "0 0 12px" }}>
        Cutting a pressure part waits for its drawing to be released. <Link href={`/jobs/${jobId}?tab=materials&view=parts`}>Back to Materials</Link>
      </p>

      {view.canWrite && <NewDrawing view={view} busy={pending} run={run} />}

      {view.drawings.length === 0 ? (
        <p className="note" style={{ textAlign: "left" }}>No drawing is registered on this job yet.{view.canWrite ? " Add one above." : ""}</p>
      ) : (
        view.drawings.map((d) => <DrawingCard key={d.id} d={d} view={view} busy={pending} run={run} />)
      )}

      <Unlinked view={view} busy={pending} run={run} />
    </>
  );
}

type Run = (fn: () => Promise<ActionResult>, ok: string, after?: () => void) => void;

function NewDrawing({ view, busy, run }: { view: DrawingsView; busy: boolean; run: Run }) {
  const [no, setNo] = useState("");
  const [typeId, setTypeId] = useState<number | "">(view.drawingTypes[0]?.id ?? "");
  const [remarks, setRemarks] = useState("");
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="hd"><h3>Add a drawing</h3></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: 12 }}>
        <input className="ws-detail" placeholder="Drawing number" aria-label="Drawing number" value={no} onChange={(e) => setNo(e.target.value)} style={{ flex: "1 1 180px" }} />
        <select className="ws-detail" aria-label="Drawing type" value={typeId} onChange={(e) => setTypeId(Number(e.target.value))}>
          {view.drawingTypes.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <input className="ws-detail" placeholder="Remarks (optional)" aria-label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ flex: "2 1 220px" }} />
        <button
          type="button"
          className="btn btn-accent"
          disabled={busy || !no.trim() || typeId === ""}
          onClick={() => run(() => createAssemblyDrawingAction(view.job.id, Number(typeId), no.trim(), remarks.trim()), "Drawing added.", () => { setNo(""); setRemarks(""); })}
        >
          Add drawing
        </button>
      </div>
    </div>
  );
}

function DrawingCard({ d, view, busy, run }: { d: DrawingRegisterRow; view: DrawingsView; busy: boolean; run: Run }) {
  const jobId = view.job.id;
  const [issuing, setIssuing] = useState(false);
  const [revNo, setRevNo] = useState(String(d.nextRevisionNo));
  const [status, setStatus] = useState<"DRAFT" | "RELEASED">("DRAFT");
  const [risking, setRisking] = useState(false);
  const [reason, setReason] = useState("");
  const [consent, setConsent] = useState("");
  const st = STATE[d.state];
  const canRisk = view.canReleaseAtRisk && d.current && d.current.status !== "RELEASED" && !d.current.atRisk;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="hd">
        <h3>
          <span className="mono">{d.drawingNo}</span> <span style={{ color: "var(--muted)", fontWeight: 400 }}>{d.typeName}</span>
        </h3>
        <span className={`chip ${st.cls}`}><i />{st.label}</span>
      </div>
      <div style={{ padding: 12 }}>
        {d.remarks && <p style={{ margin: "0 0 8px", color: "var(--muted)" }}>{d.remarks}</p>}
        <p style={{ margin: "0 0 8px", color: "var(--muted)" }}>{plural(d.linkedParts, "part")} follow this drawing.</p>
        {d.revisions.length === 0 ? (
          <p style={{ margin: "0 0 8px" }}>No revision issued yet. Cutting of the parts linked to it cannot start.</p>
        ) : (
          <div className="sh-hist" style={{ marginBottom: 8 }}>
            {d.revisions.map((r) => (
              <div key={r.id}>
                Rev {r.revisionNo}{" "}
                <span className={`chip ${r.status === "RELEASED" ? "c-complete" : r.status === "SUPERSEDED" ? "c-idle" : "c-progress"}`}><i />{REV[r.status] ?? r.status}</span>{" "}
                {r.atRisk && <span className="chip c-hold"><i />At risk</span>}
                <small> {r.releasedAt ? `released ${fmt(r.releasedAt)}` : ""}</small>
                {r.atRisk && (
                  <small style={{ display: "block" }}>
                    Released at risk {fmt(r.atRisk.at)}{r.atRisk.by ? ` by ${r.atRisk.by}` : ""}: {r.atRisk.reason}
                    {r.atRisk.clientConsentRef ? ` (client consent ${r.atRisk.clientConsentRef})` : ""}
                  </small>
                )}
              </div>
            ))}
          </div>
        )}

        {issuing ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
            <input className="ws-detail" type="number" min="0" aria-label="Revision number" value={revNo} onChange={(e) => setRevNo(e.target.value)} style={{ width: 110 }} />
            <select className="ws-detail" aria-label="Revision status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="DRAFT">Draft</option>
              <option value="RELEASED">Released</option>
            </select>
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy || revNo.trim() === "" || !Number.isInteger(Number(revNo)) || Number(revNo) < 0}
              onClick={() => run(() => createDrawingRevisionAction(jobId, d.id, Number(revNo), status), "Revision issued.", () => setIssuing(false))}
            >
              Issue revision
            </button>
            <button type="button" className="btn" onClick={() => setIssuing(false)}>Cancel</button>
          </div>
        ) : risking ? (
          <div style={{ display: "grid", gap: 6, margin: "8px 0", maxWidth: 520 }}>
            <p style={{ margin: 0 }}>Cutting starts on Rev {d.current?.revisionNo} before it is released. Say why; this is recorded against the revision, and a newer revision cancels it.</p>
            <textarea className="ws-detail" aria-label="Reason for releasing at risk" placeholder="Reason (required)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            <input className="ws-detail" aria-label="Client consent reference" placeholder="Client consent reference (optional)" value={consent} onChange={(e) => setConsent(e.target.value)} />
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="btn btn-accent"
                disabled={busy || !reason.trim()}
                onClick={() => run(() => releaseDrawingAtRiskAction(jobId, d.current!.id, reason.trim(), consent.trim() || undefined), "Released at risk.", () => { setRisking(false); setReason(""); setConsent(""); })}
              >
                Release at risk
              </button>
              <button type="button" className="btn" onClick={() => setRisking(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {view.canWrite && (
              <button type="button" className="btn" onClick={() => { setRevNo(String(d.nextRevisionNo)); setIssuing(true); }}>Issue revision…</button>
            )}
            {canRisk && <button type="button" className="btn" onClick={() => setRisking(true)}>Release at risk…</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function Unlinked({ view, busy, run }: { view: DrawingsView; busy: boolean; run: Run }) {
  const [lineId, setLineId] = useState<number | "">(view.lines[0]?.id ?? "");
  const [pickedDrawing, setDrawingId] = useState<number | "">("");
  // The first drawing until one is picked: the list may be empty when this mounts and fill after a refresh.
  const drawingId = pickedDrawing === "" ? (view.drawings[0]?.id ?? "") : pickedDrawing;
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const shown = useMemo(() => view.unlinked.filter((p) => p.lineId === lineId), [view.unlinked, lineId]);
  const chosen = shown.filter((p) => picked.has(p.id)).map((p) => p.id);
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="hd"><h3>Pressure parts with no drawing</h3><span className="mono">{view.unlinked.length}</span></div>
      <div style={{ padding: 12 }}>
        {view.unlinked.length === 0 ? (
          <p style={{ margin: 0 }}>Every pressure part on this job has a drawing.</p>
        ) : (
          <>
            <p style={{ margin: "0 0 8px", color: "var(--muted)" }}>Cutting these parts is not held for a drawing until they are linked to one.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <select className="ws-detail" aria-label="Line" value={lineId} onChange={(e) => { setLineId(Number(e.target.value)); setPicked(new Set()); }}>
                {view.lines.map((l) => (
                  <option key={l.id} value={l.id}>{l.name} ({view.unlinked.filter((p) => p.lineId === l.id).length})</option>
                ))}
              </select>
              <button type="button" className="btn" onClick={() => setPicked(new Set(shown.map((p) => p.id)))}>Select all</button>
              <button type="button" className="btn" onClick={() => setPicked(new Set())}>Clear</button>
            </div>
            {shown.length === 0 ? (
              <p style={{ margin: 0 }}>Nothing to link on this line.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0, display: "grid", gap: 4, gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
                {shown.map((p) => (
                  <li key={p.id}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                      <b>{p.tag}</b>
                      {p.serialNo && <span className="mono" style={{ color: "var(--muted)" }}>{p.serialNo}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {view.canWrite ? (
              view.drawings.length === 0 ? (
                <p style={{ margin: 0 }}>Add a drawing above first.</p>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <select className="ws-detail" aria-label="Drawing to link to" value={drawingId} onChange={(e) => setDrawingId(Number(e.target.value))}>
                    {view.drawings.map((d) => (
                      <option key={d.id} value={d.id}>{d.drawingNo}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy || chosen.length === 0}
                    onClick={() => run(() => linkDrawingToComponentsAction(view.job.id, Number(drawingId), chosen), `${plural(chosen.length, "part")} linked.`, () => setPicked(new Set()))}
                  >
                    Link {chosen.length > 0 ? plural(chosen.length, "selected part") : "selected parts"}
                  </button>
                </div>
              )
            ) : (
              <p style={{ margin: 0, color: "var(--muted)" }}>Linking is for Engineering, the Production Head and Admins.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
