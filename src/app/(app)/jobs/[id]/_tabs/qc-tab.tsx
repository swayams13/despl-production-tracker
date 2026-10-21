import Link from "next/link";
import { QcpGrid } from "@/components/industrial/qcp-grid";
import { HOLD_STATUS_LABEL, qcHref, type HoldRow, type NcrQueueRow, type QcCounts } from "@/lib/shared/qc-queue";
import type { QcpGrid as QcpGridData } from "@/lib/services/qcp-grid.read";

const SHOW = 8;

const NCR_STATUS: Record<NcrQueueRow["status"], string> = { OPEN: "Open", DISPOSITIONED: "Dispositioned", REWORK_IN_PROGRESS: "Rework in progress" };

/**
 * Lean Core L2.8: this job's hold points, NCRs and QCP. Counts and rows come
 * from the QC queue's own builders scoped with `job=`, so the numbers here are
 * the numbers on `/qc`. Actions (accept, reject, disposition, ratify) stay in
 * the queue: every list links there instead of duplicating its forms. The
 * per-unit QCP grid below keeps its own Record / waiver actions as today.
 * `queue` is null for roles that cannot open the QC queue.
 */
export function QcTab({
  jobId,
  queue,
  qcp,
  canApproveWaiver,
  canRecord,
}: {
  jobId: number;
  queue: { counts: QcCounts; holds: HoldRow[]; ncrs: NcrQueueRow[] } | null;
  qcp: QcpGridData | null;
  canApproveWaiver: boolean;
  canRecord: boolean;
}) {
  return (
    <>
      {queue && (
        <>
          <div className="jt-tiles" role="group" aria-label="QC for this job">
            <Link className="jt-tile" href={qcHref({ tab: "ready", jobId })}>
              <span>Ready to inspect</span>
              <b className="mono">{queue.counts.ready}</b>
            </Link>
            <Link className="jt-tile" href={qcHref({ tab: "holds", jobId })}>
              <span>Open hold points</span>
              <b className="mono">{queue.counts.holds}</b>
            </Link>
            <Link className="jt-tile" href={qcHref({ tab: "ncrs", jobId })}>
              <span>Open NCRs</span>
              <b className="mono">{queue.counts.ncrs}</b>
            </Link>
          </div>

          <div className="grid-2">
            <section className="card" aria-labelledby="jt-holds">
              <div className="hd">
                <h3 id="jt-holds">Open hold points</h3>
                <Link className="jt-more-link" href={qcHref({ tab: "holds", jobId })}>Open in QC queue</Link>
              </div>
              {queue.holds.length === 0 ? (
                <p className="note jt-pad">No open hold points on this job.</p>
              ) : (
                <ul className="jt-list">
                  {queue.holds.slice(0, SHOW).map((h) => (
                    <li key={h.key}>
                      <span className="hclass" style={{ display: "inline-flex" }}>{h.classCode}</span>{" "}
                      <b className="mono">{h.srNo}</b> {h.activity}
                      <small>
                        {h.serialNo ? `Unit ${h.serialNo} · ` : ""}
                        {HOLD_STATUS_LABEL[h.status]} · {h.parties} · {h.ageDays} d
                      </small>
                    </li>
                  ))}
                  {queue.holds.length > SHOW && <li className="jt-more-row">+{queue.holds.length - SHOW} more in the QC queue</li>}
                </ul>
              )}
            </section>

            <section className="card" aria-labelledby="jt-ncrs">
              <div className="hd">
                <h3 id="jt-ncrs">Open NCRs</h3>
                <Link className="jt-more-link" href={qcHref({ tab: "ncrs", jobId })}>Open in QC queue</Link>
              </div>
              {queue.ncrs.length === 0 ? (
                <p className="note jt-pad">No open NCRs on this job.</p>
              ) : (
                <ul className="jt-list">
                  {queue.ncrs.slice(0, SHOW).map((n) => (
                    <li key={n.ncrId}>
                      <b className="mono">NCR {n.ncrId}</b> {n.entityLabel}
                      <small>
                        {n.serialNo ? `Unit ${n.serialNo} · ` : ""}
                        {n.awaitingRatification ? "Awaiting QC ratification" : NCR_STATUS[n.status]} · {n.categoryName} · {n.ageDays} d
                      </small>
                    </li>
                  ))}
                  {queue.ncrs.length > SHOW && <li className="jt-more-row">+{queue.ncrs.length - SHOW} more in the QC queue</li>}
                </ul>
              )}
            </section>
          </div>
        </>
      )}

      <div className="jt-gap">
        {qcp ? (
          <QcpGrid jobId={jobId} data={qcp} canApproveWaiver={canApproveWaiver} canRecord={canRecord} tabHref={`/jobs/${jobId}?tab=qc`} />
        ) : (
          <p className="note">No QCP template for this job.</p>
        )}
      </div>
    </>
  );
}
