import type { ReactNode } from "react";
import Link from "next/link";
import { CountUp } from "./count-up";

/**
 * Canonical MetricCard (DESIGN_SYSTEM.md §2: "one card = one number").
 * Wraps the `.kpi`/`.v`/`.sub`/`.pbar` markup already hand-rolled identically
 * on dashboard/page.tsx and (per COMPONENT_INVENTORY.md) the project stat
 * strip and department cards — same classes, typed entry point. Numeric
 * `value` gets the once-per-visit count-up animation (`<CountUp>`,
 * CLAUDE.md's interaction-primitives rule); pass a ReactNode (e.g. a
 * formatted date) to render it verbatim instead.
 */
export function MetricCard({
  label,
  value,
  suffix,
  sub,
  progressPercent,
  alert,
  selected,
  href,
  valueColor,
}: {
  label: ReactNode;
  value: number | ReactNode;
  /** Appended after a numeric value, e.g. "%". Ignored for a ReactNode value. */
  suffix?: ReactNode;
  sub?: ReactNode;
  /** 0-100 — draws the `.pbar` track/fill under the value. */
  progressPercent?: number;
  /** `.kpi.alert` — top border switches to `--s-overdue`. */
  alert?: boolean;
  selected?: boolean;
  /** Makes the card a clickable Link (`.kpi.clicky`), per the cross-filter-navigation rule. */
  href?: string;
  valueColor?: string;
}) {
  const cls = `kpi${href ? " clicky" : ""}${alert ? " alert" : ""}${selected ? " selected" : ""}`;
  const body = (
    <>
      <h6>{label}</h6>
      <div className="v mono" style={valueColor ? { color: valueColor } : undefined}>
        {typeof value === "number" ? <CountUp value={value} /> : value}
        {suffix && <small>{suffix}</small>}
      </div>
      {sub && <div className="sub">{sub}</div>}
      {progressPercent !== undefined && (
        <div className="pbar">
          <i style={{ width: `${progressPercent}%` }} />
        </div>
      )}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}
