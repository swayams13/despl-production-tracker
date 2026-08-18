import type { ReactNode } from "react";
import { STAGE_STATUS, type StageDisplayStatus } from "./stage-status";

/**
 * Per-status coarse-pointer icon paths (viewBox 0 0 24 24), sourced verbatim
 * from design/DESPL Supervisor Handoff.dc.html's <symbol> defs. Rendered
 * unconditionally alongside the dot; CSS (.chip i / .chip-icon, pointer:
 * coarse) picks which one is visible — never a JS matchMedia toggle.
 */
const CHIP_ICON_PATHS: Record<StageDisplayStatus, ReactNode> = {
  idle: <path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="none" />,
  progress: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" stroke="none" />
    </>
  ),
  submitted: (
    <>
      <path d="M9 3.5h6v3H9z" />
      <path d="M15 5h4v16H5V5h4" />
      <path d="M8.5 13.5l2.5 2.5 4.5-5" />
    </>
  ),
  hold: <path d="M9.5 5v14M14.5 5v14" />,
  overdue: (
    <>
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 9.5v4.5M12 17.2v.1" />
    </>
  ),
  complete: <path d="M4.5 12.5l5 5L20 6.5" />,
};

/**
 * StatusChip — the ONLY way status is communicated (never plain grey text).
 * Pill · 10.5px uppercase · 12%-opacity tinted bg · solid dot on fine
 * pointers; icon replaces the dot on coarse (touch) pointers (D28) — a 5px
 * dot isn't readable in daylight/gloved conditions. DESIGN_SPEC §Design tokens.
 */
export function StatusChip({
  status,
  label,
}: {
  status: StageDisplayStatus;
  /** override the default label (e.g. "Awaiting QC" → "Submitted") */
  label?: string;
}) {
  const meta = STAGE_STATUS[status];
  return (
    <span className={`chip ${meta.chipClass}`}>
      <i />
      <svg
        className="chip-icon"
        viewBox="0 0 24 24"
        width={13}
        height={13}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {CHIP_ICON_PATHS[status]}
      </svg>
      {label ?? meta.label}
    </span>
  );
}
