import { STAGE_STATUS, type StageDisplayStatus } from "./stage-status";

/**
 * StatusChip — the ONLY way status is communicated (never plain grey text).
 * Pill · 10.5px uppercase · 12%-opacity tinted bg · solid dot. DESIGN_SPEC §Design tokens.
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
      {label ?? meta.label}
    </span>
  );
}
