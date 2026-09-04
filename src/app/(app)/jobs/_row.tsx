"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { StageSpine } from "@/components/industrial/stage-spine";
import type { JobListItem } from "@/lib/services/jobs.read";

// ponytail: only the job-number text was a <Link>, but tr.row:hover lights up
// the whole row — matching the onClick convention already used for clickable
// rows elsewhere (command/[dept]/_client.tsx, my-day/_client.tsx).
export function JobRow({ jobId, children }: { jobId: number; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr className="row" onClick={() => router.push(`/jobs/${jobId}`)} style={{ cursor: "pointer" }}>
      {children}
    </tr>
  );
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** `<ResponsiveTable />`'s card counterpart to the 9-column jobs table — same
 * onClick-whole-row convention as `<JobRow />`, `.rt-card` shape shared with
 * workspace/my-day's card views. */
export function JobCardView({ job }: { job: JobListItem }) {
  const router = useRouter();
  return (
    <div className="rt-card" onClick={() => router.push(`/jobs/${job.id}`)} style={{ cursor: "pointer" }}>
      <div className="rt-card-top">
        <b className="mono">{job.jobNumber}</b>
        <span className="mono" style={{ fontSize: 12 }}>{job.percentComplete}%</span>
      </div>
      <div className="rt-card-meta">
        {job.familyName} · {job.projectName ?? "—"} · {job.unitCount} unit{job.unitCount === 1 ? "" : "s"}
      </div>
      {job.unitRollup.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <StageSpine variant="mini" segments={job.unitRollup} />
        </div>
      )}
      <div className="rt-card-row">
        <span>
          {job.committedDeliveryDate == null || job.forecastVarianceDays == null ? (
            "No schedule"
          ) : (
            <span
              className="mono"
              style={{ color: job.forecastVarianceDays > 0 ? "var(--s-overdue)" : "var(--s-complete)", fontWeight: 600 }}
            >
              {job.forecastVarianceDays > 0 ? "+" : ""}
              {job.forecastVarianceDays}d vs due
            </span>
          )}
        </span>
        <span className="mono" style={{ color: job.openHoldPoints > 0 ? "var(--s-hold)" : "var(--muted)" }}>
          {job.openHoldPoints} open hold{job.openHoldPoints === 1 ? "" : "s"}
        </span>
        <span>{fmtWhen(job.lastActivityAt)}</span>
      </div>
    </div>
  );
}
