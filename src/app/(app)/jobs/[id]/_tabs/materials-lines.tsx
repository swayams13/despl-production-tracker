"use client";

// Rendered on the client on purpose: as server-rendered <li> children, a long list is streamed as dozens of
// separate outlined Flight rows, and the browser then never commits a client-side navigation to this tab.
// As props they travel in one row. (L2.8 integration, 16 Oct 2026.)
import type { MaterialLine } from "@/lib/services/job-materials.read";

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


export function MaterialLines({ lines, multi }: { lines: MaterialLine[]; multi: boolean }) {
  return (
    <ul className="jt-lines">
      {lines.map((l) => (
        <Line key={l.id} line={l} multi={multi} />
      ))}
    </ul>
  );
}
