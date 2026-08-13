import { cn } from "@/lib/utils";

/**
 * Stat tile (dataviz skill: "a single current value + maybe a trend" — never
 * a one-bar bar chart for this job). Contract: label, value, optional signed
 * delta, optional sparkline.
 */

export interface KpiDelta {
  /** Signed change vs `period`, e.g. +12 or -3. */
  value: number;
  /** e.g. "vs last week", "vs plan". */
  period: string;
  /** Is an increase actually good? (An "overdue count" going up is bad.) */
  upIsGood: boolean;
  suffix?: string;
}

export interface KpiTileProps {
  label: string;
  value: string | number;
  /** Only used when `value` is a number; overrides the default formatter. */
  format?: (n: number) => string;
  suffix?: string;
  delta?: KpiDelta;
  /** Recent values, oldest → newest. Last point is "current period". */
  sparkline?: number[];
  icon?: React.ReactNode;
  className?: string;
}

function defaultFormat(n: number): string {
  if (Math.abs(n) >= 100_000) {
    return new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  }
  return new Intl.NumberFormat("en-IN").format(n);
}

function Delta({ delta }: { delta: KpiDelta }) {
  const direction = delta.value > 0 ? "up" : delta.value < 0 ? "down" : "flat";
  const isGood = direction === "flat" ? null : (direction === "up") === delta.upIsGood;
  const color = isGood === null ? "var(--muted-fg)" : isGood ? "var(--good)" : "var(--crit)";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "→";
  const magnitude = `${Math.abs(delta.value)}${delta.suffix ?? ""}`;

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color }}>
      <span aria-hidden="true">{arrow}</span>
      <span className="tabular">{magnitude}</span>
      <span className="font-normal text-[var(--muted-fg)]">{delta.period}</span>
    </span>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 64;
  const h = 20;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / range) * h;
    return [x, y] as const;
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1];

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden="true">
      <path d={path} fill="none" stroke="var(--muted-fg)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.5} />
      <circle cx={lastX} cy={lastY} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

export function KpiTile({ label, value, format = defaultFormat, suffix, delta, sparkline, icon, className }: KpiTileProps) {
  const displayValue = typeof value === "number" ? format(value) : value;

  return (
    <div
      className={cn(
        "rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-4",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-[var(--muted-fg)]">{label}</div>
        {icon && <div className="text-[var(--muted-fg)]">{icon}</div>}
      </div>
      <div className="mt-1 flex items-end justify-between gap-3">
        <div className="text-2xl font-semibold">
          {displayValue}
          {suffix && <span className="ml-0.5 text-base font-medium text-[var(--muted-fg)]">{suffix}</span>}
        </div>
        {sparkline && <Sparkline points={sparkline} />}
      </div>
      {delta && (
        <div className="mt-1.5">
          <Delta delta={delta} />
        </div>
      )}
    </div>
  );
}
