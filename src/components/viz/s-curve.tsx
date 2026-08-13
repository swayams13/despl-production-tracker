"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Planned-vs-actual cumulative line chart (dataviz skill: "above/below a
 * baseline" → line vs baseline; "one series is the point, rest are context"
 * → emphasis). Planned is the de-emphasis reference line; actual carries the
 * accent hue, since it's the series the reader is meant to read.
 *
 * A real chart is interactive by default (interaction.md) — this ships a
 * crosshair that snaps to the nearest point and a tooltip listing both
 * series, reachable by pointer AND keyboard focus. A visually-hidden table
 * carries the same data for assistive tech / the "table view always exists"
 * non-negotiable.
 */

export interface SCurvePoint {
  label: string;
  planned: number;
  /** null = no actual recorded yet (future period). */
  actual: number | null;
}

export interface SCurveProps {
  data: SCurvePoint[];
  valueSuffix?: string;
  height?: number;
  className?: string;
}

const WIDTH = 480;
const PAD_X = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

export function SCurve({ data, valueSuffix = "%", height = 220, className }: SCurveProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (data.length < 2) return null;

  const plotW = WIDTH - PAD_X * 2;
  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const maxValue = Math.max(...data.map((d) => Math.max(d.planned, d.actual ?? 0))) * 1.1 || 1;

  const x = (i: number) => PAD_X + (i / (data.length - 1)) * plotW;
  const y = (v: number) => PAD_TOP + plotH - (v / maxValue) * plotH;

  const plannedPath = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.planned).toFixed(1)}`).join(" ");
  // Actual indices, in dataset order — kept explicit (not data.indexOf) so the
  // area-fill closing path below is correct even if `actual` doesn't start at
  // index 0 (a mid-project baseline, say).
  const actualIndices = data.reduce<number[]>((acc, d, i) => {
    if (d.actual != null) acc.push(i);
    return acc;
  }, []);
  const actualPath = actualIndices
    .map((i, k) => `${k === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(data[i].actual!).toFixed(1)}`)
    .join(" ");
  const actualAreaPath =
    actualIndices.length > 0
      ? `${actualPath} L${x(actualIndices[actualIndices.length - 1]).toFixed(1)},${y(0).toFixed(1)} L${x(actualIndices[0]).toFixed(1)},${y(0).toFixed(1)} Z`
      : "";

  const active = activeIndex != null ? data[activeIndex] : null;

  return (
    <div className={cn("rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-4", className)}>
      {/* Legend — line keys, not boxes, per interaction.md. */}
      <div className="mb-2 flex items-center gap-4 text-xs text-[var(--muted-fg)]">
        <span className="inline-flex items-center gap-1.5">
          <svg width="14" height="2" aria-hidden="true">
            <line x1="0" y1="1" x2="14" y2="1" stroke="var(--muted-fg)" strokeWidth={2} />
          </svg>
          Planned
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="14" height="2" aria-hidden="true">
            <line x1="0" y1="1" x2="14" y2="1" stroke="var(--accent)" strokeWidth={2} />
          </svg>
          Actual
        </span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={`Planned versus actual progress over ${data.length} periods`}
          onPointerLeave={() => setActiveIndex(null)}
        >
          {/* Baseline */}
          <line x1={PAD_X} y1={y(0)} x2={WIDTH - PAD_X} y2={y(0)} stroke="var(--grid-line)" strokeWidth={1} />

          <path d={plannedPath} fill="none" stroke="var(--muted-fg)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.6} />
          {actualAreaPath && (
            <>
              {/* Area wash at ~10% opacity, per the mark spec — a wash, never a saturated block. */}
              <path d={actualAreaPath} fill="var(--accent)" opacity={0.1} stroke="none" />
              <path d={actualPath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </>
          )}

          {/* Crosshair + hit targets, pointer and keyboard alike. */}
          {data.map((d, i) => (
            <g key={d.label}>
              <rect
                x={x(i) - plotW / (data.length - 1) / 2}
                y={0}
                width={plotW / (data.length - 1)}
                height={height}
                fill="transparent"
                tabIndex={0}
                aria-label={`${d.label}: planned ${d.planned}${valueSuffix}${d.actual != null ? `, actual ${d.actual}${valueSuffix}` : ""}`}
                onPointerEnter={() => setActiveIndex(i)}
                onFocus={() => setActiveIndex(i)}
                onBlur={() => setActiveIndex(null)}
              />
              {activeIndex === i && (
                <>
                  <line x1={x(i)} y1={PAD_TOP} x2={x(i)} y2={height - PAD_BOTTOM} stroke="var(--muted-fg)" strokeWidth={1} strokeDasharray="2,2" />
                  <circle cx={x(i)} cy={y(d.planned)} r={4} fill="var(--muted-fg)" stroke="var(--surface)" strokeWidth={2} />
                  {d.actual != null && <circle cx={x(i)} cy={y(d.actual)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />}
                </>
              )}
            </g>
          ))}

          {/* X labels: first, last, and the active point only — avoid clutter. */}
          {[0, data.length - 1].map((i) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : "end"} className="fill-[var(--muted-fg)]" fontSize={10}>
              {data[i].label}
            </text>
          ))}
        </svg>

        {active && (
          <div
            className="pointer-events-none absolute top-2 z-10 -translate-x-1/2 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-sm"
            style={{ left: `${(activeIndex! / (data.length - 1)) * 100}%` }}
          >
            <div className="font-medium">{active.label}</div>
            <div className="tabular mt-0.5 flex items-center gap-1.5 text-[var(--muted-fg)]">
              <svg width="10" height="2" aria-hidden="true"><line x1="0" y1="1" x2="10" y2="1" stroke="var(--muted-fg)" strokeWidth={2} /></svg>
              Planned <span className="font-semibold text-[var(--ink)]">{active.planned}{valueSuffix}</span>
            </div>
            {active.actual != null && (
              <div className="tabular mt-0.5 flex items-center gap-1.5 text-[var(--muted-fg)]">
                <svg width="10" height="2" aria-hidden="true"><line x1="0" y1="1" x2="10" y2="1" stroke="var(--accent)" strokeWidth={2} /></svg>
                Actual <span className="font-semibold text-[var(--accent)]">{active.actual}{valueSuffix}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>Planned versus actual progress</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Planned</th>
            <th scope="col">Actual</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{d.planned}{valueSuffix}</td>
              <td>{d.actual != null ? `${d.actual}${valueSuffix}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
