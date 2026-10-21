"use client";

// Client components on purpose: server-rendered, keyed list rows are streamed as many separate outlined Flight
// rows, and a client-side navigation to a page with dozens of them never commits in the browser (found in the
// L2.7-L2.9 integration run, 16 Oct 2026). As props they travel in one row.
import { errorLabel } from "@/lib/shared/errors";
import { PackingPanel } from "@/components/industrial/packing-panel";
import { DispatchPanel } from "@/components/industrial/dispatch-panel";
import type { PackingPanel as PackingPanelData } from "@/lib/services/packing.read";
import type { DispatchPanel as DispatchPanelData, UnitDispatchReadiness } from "@/lib/services/dispatch.read";

/**
 * Lean Core L2.8: packing and dispatch on one tab. Above them, why units cannot
 * ship yet: the service's own gates (open NCR, open hold point, incomplete
 * production; invariant 2) run read-only, so the refusal a click would get is
 * visible beforehand, with the same codes.
 */
export function DispatchTab({
  jobId,
  packing,
  dispatch,
  readiness,
  canManagePacking,
  canManageDispatch,
}: {
  jobId: number;
  packing: PackingPanelData | null;
  dispatch: DispatchPanelData | null;
  readiness: UnitDispatchReadiness[] | null;
  canManagePacking: boolean;
  canManageDispatch: boolean;
}) {
  const blocked = (readiness ?? []).filter((u) => u.blocks.length > 0 && !u.batched);
  return (
    <>
      {readiness && readiness.length > 0 && (
        <section className="card jt-gap-b" aria-labelledby="jt-ready">
          <div className="hd">
            <h3 id="jt-ready">Ready to ship</h3>
            <span className={`chip ${blocked.length > 0 ? "c-overdue" : "c-complete"}`}>
              <i />
              <span>{blocked.length > 0 ? `${blocked.length} of ${readiness.length} units blocked` : "No unit is blocked"}</span>
            </span>
          </div>
          {blocked.length === 0 ? (
            <p className="note jt-pad">No unit has an open NCR, an open hold point or unfinished production.</p>
          ) : (
            <ul className="jt-list">
              {blocked.map((u) => (
                <li key={u.unitId}>
                  <b>Unit <span className="mono">{u.serialNo}</span></b> cannot be released or dispatched yet
                  {u.blocks.map((b) => (
                    <small key={b.code}>
                      <span className="chip c-overdue"><i /><span>{errorLabel(b.code)}</span></span> {b.message}
                    </small>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <div className="jt-stack">
        {packing ? <PackingPanel jobId={jobId} data={packing} canManagePacking={canManagePacking} /> : <p className="note">No packing data for this job.</p>}
        {dispatch ? <DispatchPanel jobId={jobId} data={dispatch} canManageDispatch={canManageDispatch} /> : <p className="note">No dispatch data for this job.</p>}
      </div>
    </>
  );
}
