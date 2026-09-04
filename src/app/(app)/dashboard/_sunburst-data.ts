import type { Portfolio, PortfolioRow } from "@/lib/services/portfolio.read";
import { HEALTH_LABEL, HEALTH_ORDER, type JobHealth } from "@/lib/services/job-health";
import type { SunburstNode } from "@/components/viz/sunburst";

/**
 * S13b — reshapes `loadPortfolio()`'s already-computed output into a sunburst
 * tree: Health -> Job -> stage-status. No new query; `Portfolio.rows` already
 * carries `health`, `totalPlans`, `completePlans`, `overduePlans` per job.
 *
 * Colors reuse `health-chip.tsx`'s `HEALTH_CLASS` mapping exactly (via the
 * `--s-*` tokens it resolves to) — a status/health ring draws from this
 * app's existing status-color vocabulary, never an arbitrary categorical
 * scale (dataviz convention this repo's other charts already follow).
 */
const HEALTH_COLOR: Record<JobHealth, string> = {
  ON_TRACK: "var(--s-progress)",
  AT_RISK: "var(--s-hold)",
  DELAYED: "var(--s-overdue)",
  COMPLETED: "var(--s-complete)",
  ON_HOLD: "var(--s-idle)",
  NOT_PLANNED: "var(--s-idle)",
};

/** Per-job stage-status breakdown, ring 3 — complete / overdue / everything else (not-started or in-progress, neither done nor late). */
function stageStatusChildren(row: PortfolioRow): SunburstNode[] {
  const remaining = Math.max(0, row.totalPlans - row.completePlans - row.overduePlans);
  const children: SunburstNode[] = [];
  if (row.completePlans > 0) children.push({ name: "Complete", value: row.completePlans, color: "var(--s-complete)" });
  if (row.overduePlans > 0) children.push({ name: "Overdue", value: row.overduePlans, color: "var(--s-overdue)" });
  if (remaining > 0) children.push({ name: "In progress", value: remaining, color: "var(--s-progress)" });
  return children;
}

export function portfolioToSunburst(portfolio: Portfolio): SunburstNode[] {
  const byHealth = new Map<JobHealth, PortfolioRow[]>();
  for (const row of portfolio.rows) {
    const list = byHealth.get(row.health);
    if (list) list.push(row);
    else byHealth.set(row.health, [row]);
  }

  return HEALTH_ORDER.map((health) => {
    const rows = byHealth.get(health) ?? [];
    return {
      name: HEALTH_LABEL[health],
      // A job with no schedule yet (totalPlans === 0, e.g. NOT_PLANNED)
      // still needs a nonzero slice to be visible/selectable in the ring —
      // floor it at 1 rather than let it vanish from the chart entirely.
      value: rows.reduce((sum, r) => sum + Math.max(1, r.totalPlans), 0),
      color: HEALTH_COLOR[health],
      children: rows.map((row) => ({
        name: row.jobNumber,
        value: Math.max(1, row.totalPlans),
        color: HEALTH_COLOR[health],
        children: stageStatusChildren(row),
      })),
    };
  }).filter((node) => node.value > 0);
}
