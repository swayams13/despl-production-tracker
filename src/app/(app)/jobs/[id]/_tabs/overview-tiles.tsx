import Link from "next/link";
import type { JobHeader } from "@/lib/services/job-detail.read";
import { qcHref } from "@/lib/shared/qc-queue";

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });

/**
 * Lean Core L2.8 (frame 07A, audit §3): the numbers the header already carries,
 * each linking to where it is worked. Progress vs plan % is not computed yet,
 * so this shows progress alone. Every tile is a link (no dead controls).
 */
export function OverviewTiles({ jobId, header, openHolds }: { jobId: number; header: JobHeader; openHolds: number | null }) {
  const v = header.forecastVarianceDays;
  return (
    <div className="jt-tiles" role="group" aria-label="Job health">
      <Link className="jt-tile" href={`/jobs/${jobId}?tab=schedule`}>
        <span>Progress</span>
        <b className="mono">{header.percentComplete}%</b>
        <small>
          {header.completePlans} of {header.totalPlans} processes done
        </small>
      </Link>
      <Link className="jt-tile" href={`/jobs/${jobId}?tab=schedule`}>
        <span>Forecast</span>
        <b className="mono">{header.forecastDispatch ? fmtDay(header.forecastDispatch) : "—"}</b>
        <small>
          {header.committedDeliveryDate ? `Committed ${fmtDay(header.committedDeliveryDate)}` : "No committed date"}
          {v != null && v !== 0 ? ` · ${v > 0 ? "+" : "−"}${Math.abs(v)} d` : ""}
        </small>
      </Link>
      <Link className="jt-tile" href={`/jobs/${jobId}/board?status=overdue`}>
        <span>Overdue processes</span>
        <b className="mono">{header.overduePlans}</b>
        <small>Open on the Board</small>
      </Link>
      {openHolds != null && (
        <Link className="jt-tile" href={qcHref({ tab: "holds", jobId })}>
          <span>Open hold points</span>
          <b className="mono">{openHolds}</b>
          <small>Open in the QC queue</small>
        </Link>
      )}
    </div>
  );
}
