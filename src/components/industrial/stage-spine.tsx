"use client";

import { STAGE_STATUS, showsOverduePip, type StageSegment } from "./stage-status";

/**
 * StageSpine — the signature element. A horizontal segmented bar of the 25
 * work-order stages, colour-coded by rolled-up status (DESIGN_SPEC §11).
 *
 * - `mini`  : 4px non-interactive strip for job rows / the job switcher.
 * - `full`  : interactive segments (click → StageSheet) for the job page.
 *
 * Fill colour = STAGE_STATUS[status]. A hold segment that is also overdue gets
 * the red corner pip (C26) via `showsOverduePip`.
 */
export function StageSpine({
  segments,
  variant = "full",
  waypoints,
  onSegmentClick,
}: {
  segments: StageSegment[];
  variant?: "mini" | "full";
  /** optional labelled waypoints under a full spine (e.g. 1 · PO receipt) */
  waypoints?: { no: number; label: string }[];
  onSegmentClick?: (seg: StageSegment, index: number) => void;
}) {
  if (variant === "mini") {
    return (
      <span className="spine-mini" aria-hidden="true">
        {segments.map((seg, i) => (
          <i
            key={i}
            className={showsOverduePip(seg) ? "pip-od" : undefined}
            style={{ background: STAGE_STATUS[seg.status].colorVar }}
          />
        ))}
      </span>
    );
  }

  return (
    <div>
      <div className="spine" role="list" aria-label="Work-order stages">
        {segments.map((seg, i) => (
          <button
            key={i}
            type="button"
            role="listitem"
            className={showsOverduePip(seg) ? "pip-od" : undefined}
            style={{ background: STAGE_STATUS[seg.status].colorVar }}
            title={`Stage ${seg.stageNo} · ${seg.stageName} — ${STAGE_STATUS[seg.status].label}${
              showsOverduePip(seg) ? " · overdue" : ""
            }`}
            aria-label={`Stage ${seg.stageNo}, ${seg.stageName}, ${STAGE_STATUS[seg.status].label}`}
            onClick={onSegmentClick ? () => onSegmentClick(seg, i) : undefined}
          />
        ))}
      </div>
      {waypoints && waypoints.length > 0 && (
        <div className="spine-lab">
          {waypoints.map((w) => (
            <span key={w.no}>
              {w.no} · {w.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
