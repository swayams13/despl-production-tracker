import Link from "next/link";
import { BomPanel } from "@/components/industrial/bom-panel";
import type { BomTree } from "@/lib/services/bom.read";
import type { JobMaterials, MaterialLine } from "@/lib/services/job-materials.read";

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });

const EVENT_LABEL: Record<string, string> = { INDENT_RAISED: "Indent raised", INDENT_APPROVED: "Indent approved", PO_PLACED: "PO placed", RECEIPT: "Received" };

function Pipeline({ line }: { line: MaterialLine }) {
  return (
    <ol className="jt-pipe" aria-label="Pipeline">
      {line.chips.map((c) => (
        <li key={c.key} className={`jt-step ${c.state}${c.late ? " late" : ""}`}>
          <span className="jt-bar" aria-hidden />
          <span className="jt-lab">
            {c.label}
            <span className="sr-only">{c.state === "done" ? " (done)" : c.state === "current" ? (c.late ? " (current step, will be late)" : " (current step)") : " (not started)"}</span>
          </span>
          {c.detail && <span className="jt-det">{c.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

function Line({ line, multi }: { line: MaterialLine; multi: boolean }) {
  const chip = line.status === "short" ? "c-overdue" : line.status === "issued" ? "c-complete" : line.status === "ready_to_issue" ? "c-progress" : line.status === "on_track" ? "c-progress" : "c-idle";
  return (
    <li>
      <details className="jt-line">
        <summary className="jt-row">
          <span className="jt-part">
            <b>{line.partName}</b>
            {multi && <small>{line.equipmentName}</small>}
          </span>
          <span className="jt-mat-name">{line.material ?? "—"}</span>
          <span className="mono">{line.qtyLabel}</span>
          <Pipeline line={line} />
          <span className="mono">{line.neededBy ? fmtDay(line.neededBy) : "—"}</span>
          <span className={`chip ${chip}`}>
            <i />
            <span>{line.statusLabel}</span>
          </span>
        </summary>
        <div className="jt-more">
          <div>
            <h4>Needed for</h4>
            <p>
              {line.neededFor && line.neededBy ? (
                <>
                  {line.neededFor}, planned start <b className="mono">{fmtDay(line.neededBy)}</b>
                </>
              ) : (
                "No planned date can be derived for this line yet."
              )}
            </p>
          </div>
          <div>
            <h4>Procurement</h4>
            {line.events.length === 0 ? (
              <p>Nothing logged yet.</p>
            ) : (
              <ul>
                {line.events.map((e, i) => (
                  <li key={i}>
                    {EVENT_LABEL[e.type] ?? e.type}
                    {e.qty != null && <> · <span className="mono">{e.qty}</span></>}
                    {e.refNo && <> · <span className="mono">{e.refNo}</span></>} · <span className="mono">{fmtDay(e.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4>Stock</h4>
            <p>
              Required <b className="mono">{line.requiredQty ?? "—"}</b> · received <b className="mono">{line.receivedQty ?? "—"}</b> · issued{" "}
              <b className="mono">{line.issuedQty}</b>
              {line.heats.length > 0 && <> · heat <span className="mono">{line.heats.join(", ")}</span></>}
            </p>
          </div>
        </div>
      </details>
    </li>
  );
}

/**
 * Lean Core L2.8 (frame 07B). Pipeline view: read-only, one row per BOM line.
 * "Parts and stock" view: today's BOM & Components panel, with its Stores
 * actions (receive, identify, issue) unchanged.
 */
export function MaterialsTab({
  jobId,
  view,
  onlyShort,
  materials,
  parts,
}: {
  jobId: number;
  view: "pipeline" | "parts";
  onlyShort: boolean;
  materials: JobMaterials | null;
  parts: BomTree | null;
}) {
  const sub = (
    <div className="jt-sub" role="group" aria-label="Materials view">
      <Link className={`btn${view === "pipeline" ? " jt-on" : ""}`} href={`/jobs/${jobId}?tab=materials`} aria-current={view === "pipeline" ? "page" : undefined}>
        Pipeline
      </Link>
      <Link className={`btn${view === "parts" ? " jt-on" : ""}`} href={`/jobs/${jobId}?tab=materials&view=parts`} aria-current={view === "parts" ? "page" : undefined}>
        Parts and stock
      </Link>
    </div>
  );

  if (view === "parts") {
    return (
      <>
        {sub}
        {parts ? <BomPanel jobId={jobId} bom={parts} tabHref={`/jobs/${jobId}?tab=materials&view=parts`} /> : <p className="note">No BOM loaded for this job.</p>}
      </>
    );
  }

  if (!materials || materials.lines.length === 0) {
    return (
      <>
        {sub}
        <p className="note">No BOM lines on this job yet.</p>
      </>
    );
  }
  const lines = onlyShort ? materials.lines.filter((l) => l.short) : materials.lines;
  return (
    <>
      {sub}
      <div className="jt-filters">
        <Link className={`jt-chip${onlyShort ? "" : " jt-on"}`} href={`/jobs/${jobId}?tab=materials`}>
          All <b>{materials.lines.length}</b>
        </Link>
        <Link className={`jt-chip${onlyShort ? " jt-on" : ""}`} href={`/jobs/${jobId}?tab=materials&short=1`}>
          Short this week <b>{materials.shortCount}</b>
        </Link>
        <span className="jt-hint">Read-only. Receive, identify and issue are under Parts and stock.</span>
      </div>
      {lines.length === 0 ? (
        <p className="note">Nothing is short this week.</p>
      ) : (
        <div className="card jt-table">
          <div className="jt-row jt-head" aria-hidden>
            <span>Part</span>
            <span>Material</span>
            <span>Qty</span>
            <span>Pipeline</span>
            <span>Needed by</span>
            <span>Status</span>
          </div>
          <ul className="jt-lines">
            {lines.map((l) => (
              <Line key={l.id} line={l} multi={materials.multipleEquipment} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
