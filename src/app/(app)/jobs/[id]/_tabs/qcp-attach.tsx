"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { attachQcpTemplateAction } from "@/app/actions/job-intake";
import type { QcpAttachOption } from "@/lib/services/job-intake.read";

/** JG2: empty state of the QC tab. Production Head and Admin pick a QC plan to attach to a job that has none. */
export function QcpAttach({ jobId, options }: { jobId: number; options: QcpAttachOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<number | null>(null);
  const anyGap = options.some((o) => o.gaps.length > 0);

  function attach() {
    if (picked == null) return;
    start(async () => {
      const r = await attachQcpTemplateAction(jobId, picked);
      if (!r.ok) return void toast.error(r.message);
      const a = r.attached!;
      toast.success(`QC plan attached: ${a.itemCount} checkpoints, ${a.bound} assembly steps linked.`);
      if (a.leftUnbound.length > 0) toast.info(`${a.leftUnbound.length} inspection steps already started stay unlinked.`);
      if (a.unmatchedProcessCodes.length > 0) toast.info(`Not linked to a process on this route: ${a.unmatchedProcessCodes.join(", ")}.`);
      router.refresh();
    });
  }

  return (
    <div className="card">
      <div className="hd"><h3>This job has no QC plan</h3></div>
      <div style={{ padding: 16 }}>
        <p className="emp-hint" style={{ marginTop: 0 }}>No hold points will block completion until one is attached. Only steps not yet started are linked; a plan cannot be replaced afterwards.</p>
        <select
          className="ws-detail"
          aria-label="QC plan to attach"
          value={picked ?? ""}
          onChange={(e) => setPicked(e.target.value ? Number(e.target.value) : null)}
          style={{ maxWidth: 460 }}
          disabled={pending}
        >
          <option value="">Choose a QC plan</option>
          {options.map((q) => (
            <option key={q.id} value={q.id}>
              {q.vessel} rev {q.revision} — {q.itemCount} {q.itemCount === 1 ? "item" : "items"} ({q.label}){q.gaps.length > 0 ? " — may not cover the assembly checklist" : ""}
            </option>
          ))}
        </select>{" "}
        <button type="button" className="btn btn-accent" onClick={attach} disabled={picked == null || pending}>
          {pending ? "Attaching" : "Attach QC plan"}
        </button>
        {anyGap && (
          <div className="emp-hint" style={{ marginTop: 6 }}>
            Plans marked as possibly not covering the assembly checklist may be refused when attached. If so, pick another QC plan.
          </div>
        )}
      </div>
    </div>
  );
}
