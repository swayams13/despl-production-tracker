import { cn } from "@/lib/utils";
import type { Status } from "./status";

/**
 * Meter (dataviz skill: "a single ratio against a limit" — never a 2-slice
 * pie for this job), radial variant. The fill carries severity; the unfilled
 * track is a lighter step of the same ramp so state reads across the whole
 * shape, not just the fill.
 */

const TRACK_BY_TONE: Record<Status, string> = {
  accent: "var(--seq-200)",
  good: "var(--good-bg)",
  warning: "var(--warn-bg)",
  serious: "var(--serious-bg)",
  critical: "var(--crit-bg)",
  neutral: "var(--surface-sunken)",
};

const FILL_BY_TONE: Record<Status, string> = {
  accent: "var(--accent)",
  good: "var(--good)",
  warning: "var(--warn)",
  serious: "var(--serious)",
  critical: "var(--crit)",
  neutral: "var(--muted-fg)",
};

export interface ProgressRingProps {
  /** 0-100. Values outside this range are clamped. */
  value: number;
  tone?: Status;
  size?: number;
  strokeWidth?: number;
  showValue?: boolean;
  /** Accessible label — required since the ring itself carries no text by default in small sizes. */
  label: string;
  className?: string;
}

export function ProgressRing({
  value,
  tone = "accent",
  size = 64,
  strokeWidth = 6,
  showValue = true,
  label,
  className,
}: ProgressRingProps) {
  const pct = Math.max(0, Math.min(100, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  const center = size / 2;

  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      role="img"
      aria-label={`${label}: ${Math.round(pct)}%`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={TRACK_BY_TONE[tone]}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={FILL_BY_TONE[tone]}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      {showValue && (
        <span
          className="absolute font-semibold"
          style={{ fontSize: Math.max(10, size * 0.24), color: FILL_BY_TONE[tone] }}
          aria-hidden="true"
        >
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}
