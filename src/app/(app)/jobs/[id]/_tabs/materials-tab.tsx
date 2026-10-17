import Link from "next/link";
import { BomPanel } from "@/components/industrial/bom-panel";
import type { BomTree } from "@/lib/services/bom.read";
import type { JobMaterials } from "@/lib/services/job-materials.read";
import { MaterialLines } from "./materials-lines";

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
  canImport = false,
  canSwitchOver = false,
}: {
  jobId: number;
  view: "pipeline" | "parts";
  onlyShort: boolean;
  materials: JobMaterials | null;
  parts: BomTree | null;
  /** Planning, Production Head and Admin: the tracker-sheet import (L2.10). */
  canImport?: boolean;
  /** Production Head and Admin, lean floor on: tick work Excel shows as done (L2.10 part B). */
  canSwitchOver?: boolean;
}) {
  const sub = (
    <div className="jt-sub" role="group" aria-label="Materials view">
      <Link className={`btn${view === "pipeline" ? " jt-on" : ""}`} href={`/jobs/${jobId}?tab=materials`} aria-current={view === "pipeline" ? "page" : undefined}>
        Pipeline
      </Link>
      <Link className={`btn${view === "parts" ? " jt-on" : ""}`} href={`/jobs/${jobId}?tab=materials&view=parts`} aria-current={view === "parts" ? "page" : undefined}>
        Parts and stock
      </Link>
      {canImport && (
        <Link className="btn" href={`/jobs/${jobId}/import`}>
          Load tracker sheet
        </Link>
      )}
      {canSwitchOver && (
        <Link className="btn" href={`/jobs/${jobId}/switch-over`}>
          Switch over from Excel
        </Link>
      )}
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
          <MaterialLines lines={lines} multi={materials.multipleEquipment} />
        </div>
      )}
    </>
  );
}
