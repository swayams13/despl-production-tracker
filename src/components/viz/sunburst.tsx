"use client";

import { useState } from "react";

/**
 * Generic sunburst: hand-rolled SVG arc math, no charting dependency — this
 * repo has none (confirmed: no d3-hierarchy/d3-shape, direct or transitive,
 * anywhere), and every existing chart in src/components/viz/* is plain SVG
 * with manual arithmetic (s-curve.tsx, matrix-heatmap.tsx). A 2-3 level
 * sunburst's arc geometry is a dozen lines of trig; pulling in d3-hierarchy's
 * partition() + d3-shape's arc() for that would be the first charting
 * dependency in the project for something this small.
 *
 * Same accessibility bar as s-curve.tsx: every arc is a real, independently
 * focusable, keyboard-operable target (an SVG has nothing a screen reader can
 * read on its own), plus a `sr-only` data-table fallback. No animation, so
 * nothing to gate behind prefers-reduced-motion (matches s-curve.tsx, which
 * has none either — state changes on hover/focus are instant everywhere in
 * this codebase's existing charts).
 */

export interface SunburstNode {
  name: string;
  value: number;
  /** CSS color value (a `var(--s-*)` token, matching this app's status-color
   * vocabulary — never an arbitrary categorical scale for a status/health
   * ring). Undefined children default to a muted fill. */
  color?: string;
  children?: SunburstNode[];
}

export interface SunburstProps {
  /** Ring 1 (innermost, around the center). */
  data: SunburstNode[];
  size?: number;
  className?: string;
}

const TAU = Math.PI * 2;

/** SVG arc path for one ring segment (annulus wedge), centered on (cx, cy). */
function arcPath(cx: number, cy: number, innerR: number, outerR: number, startAngle: number, endAngle: number): string {
  // A full circle (single segment spanning the whole ring) can't be drawn as
  // one arc command (start === end point) — nudge it a hair short.
  const angle = Math.min(endAngle - startAngle, TAU - 0.0001);
  const end = startAngle + angle;
  const large = angle > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const;
  const [x1, y1] = p(outerR, startAngle);
  const [x2, y2] = p(outerR, end);
  const [x3, y3] = p(innerR, end);
  const [x4, y4] = p(innerR, startAngle);
  return [
    `M${x1.toFixed(2)},${y1.toFixed(2)}`,
    `A${outerR},${outerR} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`,
    `L${x3.toFixed(2)},${y3.toFixed(2)}`,
    `A${innerR},${innerR} 0 ${large} 0 ${x4.toFixed(2)},${y4.toFixed(2)}`,
    "Z",
  ].join(" ");
}

interface Placed {
  key: string;
  path: string;
  color: string;
  label: string;
  value: number;
  pct: number;
  depth: number;
}

/** Flattens the tree into placed arcs, ring by ring, each ring's angular span inherited from its parent. */
function layout(nodes: SunburstNode[], cx: number, cy: number, ringWidth: number, startR: number, depth: number, startAngle: number, endAngle: number, parentKey: string, totalRoot: number): Placed[] {
  const total = nodes.reduce((sum, n) => sum + n.value, 0);
  if (total <= 0) return [];
  const span = endAngle - startAngle;
  let a = startAngle;
  const out: Placed[] = [];
  for (const n of nodes) {
    const frac = n.value / total;
    const a2 = a + frac * span;
    const key = `${parentKey}/${n.name}`;
    out.push({
      key,
      path: arcPath(cx, cy, startR, startR + ringWidth, a, a2),
      color: n.color ?? "var(--s-idle)",
      label: n.name,
      value: n.value,
      pct: totalRoot > 0 ? (n.value / totalRoot) * 100 : 0,
      depth,
    });
    if (n.children && n.children.length > 0) {
      out.push(...layout(n.children, cx, cy, ringWidth, startR + ringWidth, depth + 1, a, a2, key, totalRoot));
    }
    a = a2;
  }
  return out;
}

export function Sunburst({ data, size = 280, className }: SunburstProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const totalRoot = data.reduce((sum, n) => sum + n.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const innerHole = size * 0.14;
  const maxOuter = size / 2 - 2;
  const depthCount = (() => {
    let max = 1;
    const walk = (ns: SunburstNode[], d: number) => {
      max = Math.max(max, d);
      for (const n of ns) if (n.children?.length) walk(n.children, d + 1);
    };
    walk(data, 1);
    return max;
  })();
  const ringWidth = (maxOuter - innerHole) / depthCount;

  const arcs = totalRoot > 0 ? layout(data, cx, cy, ringWidth, innerHole, 1, 0, TAU, "", totalRoot) : [];
  const active = arcs.find((a) => a.key === activeKey) ?? null;

  if (totalRoot <= 0) {
    return <p className="note" style={{ margin: "16px 0" }}>No portfolio data yet.</p>;
  }

  return (
    <div className={className}>
      <div style={{ position: "relative", display: "flex", justifyContent: "center" }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} onPointerLeave={() => setActiveKey(null)}>
          {arcs.map((a) => (
            <path
              key={a.key}
              d={a.path}
              fill={a.color}
              opacity={activeKey == null || activeKey === a.key ? (a.depth === 1 ? 0.9 : 0.75) : 0.35}
              stroke="var(--surface)"
              strokeWidth={1}
              tabIndex={0}
              role="button"
              aria-label={`${a.label}: ${a.value} (${a.pct.toFixed(0)}%)`}
              style={{ cursor: "pointer", outlineOffset: 2 }}
              onPointerEnter={() => setActiveKey(a.key)}
              onFocus={() => setActiveKey(a.key)}
              onBlur={() => setActiveKey(null)}
            />
          ))}
        </svg>
        {active && (
          <div
            className="pointer-events-none"
            style={{
              position: "absolute",
              top: 4,
              left: "50%",
              transform: "translateX(-50%)",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 11,
              textAlign: "center",
              whiteSpace: "nowrap",
            }}
          >
            <div style={{ fontWeight: 600, color: "var(--text)" }}>{active.label}</div>
            <div className="mono" style={{ color: "var(--muted)" }}>
              {active.value} · {active.pct.toFixed(0)}%
            </div>
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>Portfolio health breakdown</caption>
        <thead>
          <tr>
            <th scope="col">Segment</th>
            <th scope="col">Value</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {arcs.map((a) => (
            <tr key={a.key}>
              <th scope="row">{"—".repeat(a.depth - 1)} {a.label}</th>
              <td>{a.value}</td>
              <td>{a.pct.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
