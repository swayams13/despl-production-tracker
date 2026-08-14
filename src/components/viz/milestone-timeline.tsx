import { cn } from "@/lib/utils";
import { STATUS_TOKENS, type Status } from "./status";

/**
 * Horizontal process/milestone timeline — a unit or job's process spine laid
 * out left to right, each step's status carried by a reserved status color
 * plus an icon and a direct label (never color alone). Markers are ≥8px
 * (r ≥ 4) with a surface ring so they stay legible sitting on the connecting
 * line, per the mark spec in the dataviz skill.
 */

export interface MilestoneItem {
  label: string;
  status: Status;
  /** Short date label shown under the marker, e.g. "12 Aug". */
  date?: string;
  /** Native tooltip / accessible detail, e.g. "Shell Welding — complete 12 Aug (planned 10 Aug)". */
  detail?: string;
}

export interface MilestoneTimelineProps {
  items: MilestoneItem[];
  onItemClick?: (index: number) => void;
  className?: string;
}

// Distinct per status so the icon alone (not just color) tells warning and
// serious apart — status color is never the only signal.
const ICON_BY_STATUS: Record<Status, string> = {
  good: "✓",
  critical: "✕",
  serious: "‼",
  warning: "!",
  accent: "●",
  neutral: "○",
};

export function MilestoneTimeline({ items, onItemClick, className }: MilestoneTimelineProps) {
  if (items.length === 0) return null;

  return (
    <div className={cn("overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-4", className)}>
      <ol className="flex min-w-max items-start">
        {items.map((item, i) => {
          const tokens = STATUS_TOKENS[item.status];
          const interactive = Boolean(onItemClick);
          return (
            <li key={`${item.label}-${i}`} className="flex items-start">
              <div className="flex w-24 flex-col items-center gap-1.5 text-center">
                <button
                  type="button"
                  disabled={!interactive}
                  onClick={() => onItemClick?.(i)}
                  title={item.detail ?? item.label}
                  aria-label={item.detail ?? `${item.label}: ${tokens.label}`}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ring-4 ring-[var(--surface)]",
                    interactive && "cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]",
                  )}
                  style={{ backgroundColor: tokens.fg, color: "#ffffff" }}
                >
                  <span aria-hidden="true">{ICON_BY_STATUS[item.status]}</span>
                </button>
                <span className="line-clamp-2 text-xs font-medium leading-tight">{item.label}</span>
                {item.date && <span className="tabular text-[11px] text-[var(--muted-fg)]">{item.date}</span>}
              </div>
              {i < items.length - 1 && (
                <div
                  className="mt-3 h-0.5 w-8 shrink-0"
                  style={{
                    backgroundColor:
                      item.status === "good" ? "var(--good)" : "var(--hairline)",
                  }}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
