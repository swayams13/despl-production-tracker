"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { publishSnapshotAction, verifySnapshotAction, rejectSnapshotAction } from "@/app/actions/client-snapshot";
import type { ClientPreview } from "@/lib/services/client-snapshot.read";

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function ClientReviewBanner({ jobId, preview }: { jobId: number; preview: ClientPreview }) {
  const [pending, startTransition] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  function run(action: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success("Done.");
        setRejecting(false);
        setReason("");
      } else {
        toast.error(result.message);
      }
    });
  }

  const status = preview.reviewStatus;

  return (
    <div className="rt-card" style={{ marginBottom: 16, borderColor: status === "REJECTED" ? "var(--s-overdue)" : undefined }}>
      <div className="rt-card-top">
        <b>
          {status === "NONE" && "Draft — not yet published"}
          {status === "PUBLISHED" && "Published, awaiting Management review"}
          {status === "REJECTED" && `Rejected: ${preview.rejectionReason ?? ""}`}
          {status === "VERIFIED" && `Verified — visible to client since ${preview.hasUpdate ? fmtWhen(preview.asOf) : "—"}`}
        </b>
        {preview.publishedByName && status !== "NONE" && (
          <span className="sub"> · published by {preview.publishedByName}</span>
        )}
      </div>

      <div className="rt-card-row" style={{ gap: 8 }}>
        {(status === "NONE" || status === "REJECTED") && (
          <button className="btn btn-accent" disabled={pending} onClick={() => run(() => publishSnapshotAction(jobId))}>
            {status === "REJECTED" ? "Re-publish today's update" : "Publish today's update"}
          </button>
        )}
        {status === "PUBLISHED" && !rejecting && (
          <>
            <button className="btn btn-accent" disabled={pending} onClick={() => run(() => verifySnapshotAction(jobId))}>
              Verify &amp; release
            </button>
            <button className="btn" disabled={pending} onClick={() => setRejecting(true)}>
              Reject…
            </button>
          </>
        )}
        {status === "PUBLISHED" && rejecting && (
          <>
            <input
              className="ws-detail"
              placeholder="Reason for rejection"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Reason for rejection"
            />
            <button className="btn" disabled={pending || !reason.trim()} onClick={() => run(() => rejectSnapshotAction(jobId, reason))}>
              Confirm reject
            </button>
            <button className="btn" disabled={pending} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
