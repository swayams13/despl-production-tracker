"use client";
import { recordQcpAction } from "@/app/actions/qcp";
import { useActionError } from "./use-action-error";

export function QcpClear({ qcpItemId, unitId }: { qcpItemId: number; unitId: number }) {
  const { pending, error, run } = useActionError();
  const btn = "rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-2 py-1 text-xs hover:bg-[var(--surface-sunken)] disabled:opacity-50";
  const call = (result: "ACCEPTED" | "REJECTED" | "NA") =>
    run(() => recordQcpAction(qcpItemId, unitId, result));
  return (
    <div className="flex items-center gap-2">
      <button disabled={pending} className={btn} onClick={() => call("ACCEPTED")}>Accept</button>
      <button disabled={pending} className={btn} onClick={() => call("REJECTED")}>Reject</button>
      <button disabled={pending} className={btn} onClick={() => call("NA")}>N/A</button>
      {error && <span className="text-xs text-[var(--danger-fg,#b91c1c)]">{error}</span>}
    </div>
  );
}
