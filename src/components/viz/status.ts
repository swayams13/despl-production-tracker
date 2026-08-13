/**
 * Shared status vocabulary for the visual component set (progress ring,
 * matrix heatmap, milestone timeline, KPI tile deltas).
 *
 * Deliberately narrow — five values, reserved meaning, never repurposed as a
 * 6th categorical series (dataviz skill: "status colors are reserved... and
 * never reused for series 4"). Maps to the DESPL design tokens already in
 * globals.css (--good/--warn/--serious/--crit), which are themselves the
 * data-viz skill's own validated reference status palette.
 *
 * `accent` is not a status — it is the plain-progress/no-verdict-yet color
 * (the primary blue), used when a value has no good/bad judgement attached
 * (e.g. a job's overall % complete before any risk assessment).
 */
export type Status = "accent" | "good" | "warning" | "serious" | "critical" | "neutral";

export interface StatusTokens {
  fg: string;
  bg: string;
  /** A step of the same ramp for tracks/borders, one notch lighter than `fg`. */
  border: string;
  label: string;
}

/**
 * CSS var references, not resolved hex — so these keep tracking the
 * light/dark swap already wired in globals.css without this file knowing
 * which mode is active.
 */
export const STATUS_TOKENS: Record<Status, StatusTokens> = {
  accent: {
    fg: "var(--accent)",
    bg: "var(--accent-soft)",
    border: "var(--accent-ring)",
    label: "In progress",
  },
  good: {
    fg: "var(--good)",
    bg: "var(--good-bg)",
    border: "var(--good)",
    label: "On track",
  },
  warning: {
    fg: "var(--warn)",
    bg: "var(--warn-bg)",
    border: "var(--warn)",
    label: "At risk",
  },
  serious: {
    fg: "var(--serious)",
    bg: "var(--serious-bg)",
    border: "var(--serious)",
    label: "Overdue",
  },
  critical: {
    fg: "var(--crit)",
    bg: "var(--crit-bg)",
    border: "var(--crit-border)",
    label: "Blocked",
  },
  neutral: {
    fg: "var(--muted-fg)",
    bg: "var(--surface-sunken)",
    border: "var(--hairline)",
    label: "Not started",
  },
};
