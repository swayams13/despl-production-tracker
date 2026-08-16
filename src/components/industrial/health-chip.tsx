import { HEALTH_LABEL, type JobHealth } from "@/lib/services/job-health";

/**
 * Project-health chip for the portfolio board. Reuses the existing status-chip
 * classes — no new CSS, no new colour tokens.
 *
 * On track is blue, not green: green already means "complete" everywhere else
 * in this app, so painting a healthy in-flight project green would make it
 * indistinguishable at a glance from a finished one — the exact confusion this
 * board exists to remove. The two grey states are separated by their labels.
 */
export const HEALTH_CLASS: Record<JobHealth, string> = {
  ON_TRACK: "c-progress",
  AT_RISK: "c-hold",
  DELAYED: "c-overdue",
  COMPLETED: "c-complete",
  ON_HOLD: "c-idle",
  NOT_PLANNED: "c-idle",
};

export function HealthChip({ health }: { health: JobHealth }) {
  return (
    <span className={`chip ${HEALTH_CLASS[health]}`}>
      <i />
      {HEALTH_LABEL[health]}
    </span>
  );
}
