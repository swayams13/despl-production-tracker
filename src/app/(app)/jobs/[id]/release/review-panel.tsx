"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import { resolveReviewRowAction } from "@/app/actions/bom-release";
import type { ReviewRow } from "@/lib/services/bom-release.read";

/**
 * J5c: started floor rows a BOM re-release changed. They stay workable on the floor; Engineering or the
 * Production Head settles each one here: Keep it, Replace it with what the current BOM wants, or Cancel it,
 * with a reason that is recorded. Only rendered for those two roles (no dead controls for anyone else).
 */

type Action = "KEEP" | "REPLACE" | "CANCEL";
const VERB: Record<Action, { button: string; title: string; effect: string }> = {
  KEEP: { button: "Keep", title: "Keep this row", effect: "The row stays as it is and the flag is cleared. It is flagged again only if its BOM line changes again." },
  REPLACE: { button: "Replace", title: "Replace this row", effect: "The row is retired (its history stays on it) and a new, not-started row is made from the current BOM." },
  CANCEL: { button: "Cancel row", title: "Cancel this row", effect: "The row is retired and nothing replaces it. Its history stays on it." },
};
const STATUS_LABEL: Record<string, string> = { NOT_STARTED: "Not started", IN_PROGRESS: "In progress", SUBMITTED: "With QC", COMPLETE: "Done", ON_HOLD: "On hold" };
const MIN_REASON = 5;

export function ReviewPanel({ jobId, rows }: { jobId: number; rows: ReviewRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<{ row: ReviewRow; action: Action } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(null);
    setReason("");
    setError(null);
  };
  const confirm = () =>
    start(async () => {
      if (!open) return;
      const r = await resolveReviewRowAction(jobId, { kind: open.row.kind, id: open.row.id, action: open.action, reason });
      if (!r.ok) return void setError(typeof r.detail?.reason === "string" && r.code === "BOM_REVIEW_BLOCKED" ? (r.detail.reason === "QC_PENDING" ? "This row is waiting for QC. Keep it, or wait for QC to finish." : "This row has an open non-conformance. Keep it, or close the NCR first.") : r.message);
      toast.success(`${VERB[open.action].button === "Cancel row" ? "Row cancelled" : open.action === "KEEP" ? "Row kept" : "Row replaced"}.`);
      close();
      router.refresh();
    });

  return (
    <div className="card" aria-label="Waiting for review">
      <div className="hd">
        <h3>Waiting for review</h3>
        <span className="note" style={{ margin: "0 0 0 auto" }}>{rows.length} {rows.length === 1 ? "row" : "rows"}</span>
      </div>
      {rows.length === 0 ? (
        <p className="note" style={{ textAlign: "left", padding: "0 16px 14px", margin: 0 }}>Nothing is waiting. A started part or step whose BOM line changes in a later revision shows up here.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Unit</th><th>Row</th><th>Status</th><th>What changed</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr className="row" key={`${r.kind}:${r.id}`}>
                  <td className="mono">{r.unit}</td>
                  <td>{r.label}</td>
                  <td><span className="chip c-hold"><i />{STATUS_LABEL[r.status] ?? r.status}</span></td>
                  <td>{r.what.length > 0 ? r.what.join("; ") : "BOM line changed"}{r.sinceRevisionNo ? ` (rev ${r.sinceRevisionNo})` : ""}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {(["KEEP", "REPLACE", "CANCEL"] as const).map((a) => (
                      <button key={a} type="button" className="btn" style={{ marginRight: 6 }} onClick={() => setOpen({ row: r, action: a })}>
                        {VERB[a].button}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <Modal
          open
          onOpenChange={(o) => !o && !pending && close()}
          title={`${VERB[open.action].title}: ${open.row.label}`}
          footer={<ModalConfirmFooter onCancel={close} onConfirm={confirm} confirmLabel={pending ? "Saving…" : VERB[open.action].button} disabled={pending || reason.trim().length < MIN_REASON} destructive={open.action === "CANCEL"} />}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <p style={{ margin: 0 }}>{VERB[open.action].effect}</p>
            <label style={{ display: "grid", gap: 4 }}>
              Reason (required, recorded with your name)
              <textarea className="ws-detail" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
              {reason.trim().length < MIN_REASON && <span className="note" style={{ textAlign: "left", margin: 0 }}>Write at least {MIN_REASON} characters to continue.</span>}
            </label>
            {error && <div role="alert"><span className="chip c-overdue"><i />{error}</span></div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
