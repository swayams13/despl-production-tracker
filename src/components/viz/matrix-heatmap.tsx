import { cn } from "@/lib/utils";
import { STATUS_TOKENS, type Status } from "./status";

/**
 * Heatmap (dataviz skill: "compare magnitude in a grid"). Built as a real
 * `<table>` with colored `<td>`s — this is deliberate, not a div-grid: it
 * satisfies the "a table view exists" accessibility non-negotiable by
 * construction, rather than needing a separate fallback view. Design-doc
 * precedent: BUILD-SPEC-v2 §3's "unit × process matrix, hoverable".
 *
 * Two color jobs, matching what the cell actually encodes:
 *   - `status`: discrete state (not-started/in-progress/complete/at-risk/
 *     overdue/blocked) — status colors, reserved meaning, icon+label via title.
 *   - `sequential`: continuous magnitude (e.g. % complete) — one hue,
 *     light→dark, from the ramp in globals.css.
 */

export interface HeatmapCell {
  status?: Status;
  /** 0-100, only used in sequential mode. */
  value?: number;
  /** Short text shown in the cell itself (e.g. an icon or "48%"). */
  content?: React.ReactNode;
  /** Native tooltip + accessible name, e.g. "SR03 · Shell Welding — Overdue 3d". */
  detail: string;
}

interface BaseProps {
  rowHeaderLabel: string;
  colHeaderLabel: string;
  rows: string[];
  cols: string[];
  cells: HeatmapCell[][];
  onCellClick?: (rowIndex: number, colIndex: number) => void;
  className?: string;
}

export type MatrixHeatmapProps = BaseProps & { mode: "status" | "sequential" };

const SEQUENTIAL_STEPS = [
  "var(--seq-100)",
  "var(--seq-150)",
  "var(--seq-200)",
  "var(--seq-250)",
  "var(--seq-300)",
  "var(--seq-350)",
  "var(--seq-400)",
  "var(--seq-450)",
  "var(--seq-500)",
  "var(--seq-550)",
  "var(--seq-600)",
  "var(--seq-650)",
  "var(--seq-700)",
];
// Steps 400+ are dark enough that cell content needs white text, not ink.
const DARK_STEP_INDEX = 6;

function sequentialBackground(value: number | undefined): string {
  if (value == null) return "var(--surface-sunken)";
  const clamped = Math.max(0, Math.min(100, value));
  const index = Math.round((clamped / 100) * (SEQUENTIAL_STEPS.length - 1));
  return SEQUENTIAL_STEPS[index];
}

function sequentialTextColor(value: number | undefined): string {
  if (value == null) return "var(--muted-fg)";
  const clamped = Math.max(0, Math.min(100, value));
  const index = Math.round((clamped / 100) * (SEQUENTIAL_STEPS.length - 1));
  return index >= DARK_STEP_INDEX ? "#ffffff" : "var(--ink)";
}

export function MatrixHeatmap({
  mode,
  rowHeaderLabel,
  colHeaderLabel,
  rows,
  cols,
  cells,
  onCellClick,
  className,
}: MatrixHeatmapProps) {
  return (
    <div className={cn("overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--surface)]", className)}>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          {rowHeaderLabel} by {colHeaderLabel}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-[var(--surface)] px-3 py-2 text-left text-xs font-medium text-[var(--muted-fg)]">
              {rowHeaderLabel}
            </th>
            {cols.map((col) => (
              <th
                key={col}
                scope="col"
                className="min-w-14 border-l border-[var(--grid-line)] px-2 py-2 text-center text-xs font-medium text-[var(--muted-fg)]"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row} className="border-t border-[var(--grid-line)]">
              <th
                scope="row"
                className="sticky left-0 z-10 whitespace-nowrap bg-[var(--surface)] px-3 py-1.5 text-left text-xs font-medium"
              >
                {row}
              </th>
              {cols.map((col, c) => {
                const cell = cells[r]?.[c];
                if (!cell) {
                  return <td key={col} className="border-l border-[var(--grid-line)] bg-[var(--surface-sunken)]" />;
                }
                const bg = mode === "status" ? STATUS_TOKENS[cell.status ?? "neutral"].bg : sequentialBackground(cell.value);
                const fg = mode === "status" ? STATUS_TOKENS[cell.status ?? "neutral"].fg : sequentialTextColor(cell.value);
                const cellClassName = "flex h-8 w-full items-center justify-center rounded text-xs font-medium transition-[filter]";
                const cellStyle = { backgroundColor: bg, color: fg };
                return (
                  <td key={col} className="border-l border-[var(--grid-line)] p-0.5 text-center">
                    {onCellClick ? (
                      <button
                        type="button"
                        onClick={() => onCellClick(r, c)}
                        title={cell.detail}
                        aria-label={cell.detail}
                        className={cn(
                          cellClassName,
                          "cursor-pointer hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]",
                        )}
                        style={cellStyle}
                      >
                        {cell.content}
                      </button>
                    ) : (
                      <div title={cell.detail} aria-label={cell.detail} className={cellClassName} style={cellStyle}>
                        {cell.content}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
