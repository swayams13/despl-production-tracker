import type { ReactNode } from "react";

/**
 * Canonical PageHeader (DESIGN_SYSTEM.md §2, COMPONENT_INVENTORY.md). Every
 * page already hand-rolls `<div className="page-h"><h1>…</h1><span
 * className="sub">…</span></div>` (dashboard, my-day, departments,
 * command/[dept], reports, welding, qc) — this is that markup as a typed
 * component, not new styling. `scopeFilters` is the optional slot
 * COMPONENT_INVENTORY.md calls for on management/analytics screens (e.g. "All
 * projects / Last 30 days") that operational screens don't need.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  scopeFilters,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned action cluster: filters, then buttons, then a muted timestamp. */
  actions?: ReactNode;
  scopeFilters?: ReactNode;
}) {
  return (
    <div className="page-h">
      <h1>{title}</h1>
      {subtitle && <span className="sub">{subtitle}</span>}
      {scopeFilters && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{scopeFilters}</div>}
      {actions && <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>{actions}</div>}
    </div>
  );
}
