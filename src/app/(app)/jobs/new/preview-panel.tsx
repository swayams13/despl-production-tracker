"use client";

import Link from "next/link";
import type { JobPreview } from "@/lib/services/job-preview.service";
import { plural } from "@/lib/shared/plural";

/** The rolled-back createJob, as the wizard holds it. */
export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; last?: JobPreview }
  | { status: "ok"; data: JobPreview }
  | { status: "error"; message: string; detail?: Record<string, unknown>; last?: JobPreview };

/** Frame 13C's right panel: what this job would get, from the real createJob run inside a rolled-back transaction. */
export function PreviewPanel({ preview, onRetry }: { preview: PreviewState; onRetry: () => void }) {
  const data = preview.status === "ok" ? preview.data : preview.status === "loading" || preview.status === "error" ? preview.last : undefined;

  return (
    <aside className="card" aria-label="What this job will get" aria-busy={preview.status === "loading"}>
      <div className="hd">
        <h3>What this job will get</h3>
        {preview.status === "loading" && <span className="emp-hint" role="status">Updating…</span>}
      </div>
      <div style={{ padding: 16 }}>
        {preview.status === "idle" && <p className="note" style={{ textAlign: "left", margin: 0 }}>Finish the order and the equipment lines to see the preview.</p>}
        {preview.status === "loading" && !data && (
          <div style={{ display: "grid", gap: 8 }}>
            {Array.from({ length: 5 }).map((_, i) => <span key={i} className="skel" style={{ height: 18, width: "100%" }} />)}
          </div>
        )}
        {preview.status === "error" && (
          <div style={{ marginBottom: 12 }}>
            <div className="chip c-overdue" role="alert"><i />{preview.message}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {typeof preview.detail?.existingJobId === "number" && <Link className="btn" href={`/jobs/${preview.detail.existingJobId}`}>View existing job →</Link>}
              <button className="btn" onClick={onRetry}>Try again</button>
            </div>
          </div>
        )}
        {data && <PreviewBody data={data} stale={preview.status !== "ok"} />}
      </div>
    </aside>
  );
}

function PreviewBody({ data, stale }: { data: JobPreview; stale: boolean }) {
  const r = data.result;
  const out = data.processes.filter((p) => !p.included);
  const inn = data.processes.filter((p) => p.included);
  return (
    <div style={stale ? { opacity: 0.6 } : undefined}>
      <dl className="sh-kv">
        <div style={{ display: "contents" }}><dt>Units</dt><dd className="mono">{r.unitCount}</dd></div>
        <div style={{ display: "contents" }}><dt>Processes</dt><dd className="mono">{inn.length} in, {out.length} out</dd></div>
        <div style={{ display: "contents" }}><dt>QC points</dt><dd className="mono">{r.qcpItemCount}</dd></div>
        <div style={{ display: "contents" }}><dt>BOM lines</dt><dd className="mono">{r.bomItemCount}</dd></div>
        <div style={{ display: "contents" }}><dt>Weld-map joints</dt><dd className="mono">{r.weldMapJointCount}</dd></div>
      </dl>
      {r.flaggedRuleCount > 0 && (
        <div className="chip c-hold" style={{ marginTop: 6 }}><i />{plural(r.flaggedRuleCount, "rule")} could not read an answer. Answer the questions on the left.</div>
      )}

      <div className="sh-sec">Left out</div>
      {out.length === 0 ? (
        <p className="emp-hint" style={{ margin: 0 }}>Every process on the route is in.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {out.map((p, i) => (
            <li key={`${p.code}-${p.line ?? ""}-${i}`}>
              {p.name}{p.line ? <span className="emp-hint"> ({p.line})</span> : null}
              <span className="emp-hint">: {p.excludedBy === "PLANNER" ? "you left it out" : why(p)}</span>
            </li>
          ))}
        </ul>
      )}
      <details style={{ marginTop: 8 }}>
        <summary className="emp-hint" style={{ cursor: "pointer" }}>{inn.length} processes are in</summary>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {inn.map((p, i) => <li key={`${p.code}-${p.line ?? ""}-${i}`}>{p.name}{p.line ? <span className="emp-hint"> ({p.line})</span> : null}</li>)}
        </ul>
      </details>

      <div className="sh-sec">Floor steps once the BOM is released</div>
      {data.lines.map((l) => {
        if ("error" in l.release) return <p key={l.name} className="emp-hint">{l.name}: {l.release.error.message}</p>;
        const c = l.release.counts;
        return (
          <div key={l.name} style={{ marginBottom: 8 }}>
            <b>{l.name}</b> <span className="emp-hint">({plural(l.units, "unit")})</span>
            <div className="emp-hint" style={{ margin: 0 }}>
              {c && (c.components > 0 || c.steps > 0)
                ? `${plural(c.components, "component")}, ${plural(c.operations, "operation")}, ${plural(c.steps, "assembly step")}`
                : "No BOM lines yet. Nothing is made until Engineering adds a BOM and releases it."}
            </div>
            {l.release.refusals.map((m) => <div key={m} className="ws-err">{m}</div>)}
            {l.release.warnings.slice(0, 3).map((m) => <div key={m} className="emp-hint">{m}</div>)}
          </div>
        );
      })}
    </div>
  );
}

function why(p: JobPreview["processes"][number]): string {
  const missing = [...new Set(p.ruleLines.flatMap((l) => l.missing))];
  if (missing.length) return `answer needed: ${missing.join(", ")}`;
  return "your answers leave it out";
}
