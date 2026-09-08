"use client";

import type { ReactNode } from "react";

/**
 * DataTable helpers (COMPONENT_INVENTORY.md's table-system rules) — NOT a
 * column-config/cell-renderer grid. `ResponsiveTable`'s own docstring
 * explains why one doesn't exist here: this codebase's tables have
 * heterogeneous, stateful rows (delay-reason selects, role-gated actions,
 * maker-checker read-only rendering) that a generic renderer would fight,
 * not help. These are the two pieces the design doc actually calls for that
 * don't already exist: a sortable column header (sort = column-header click)
 * and a Detail-tier row-expansion toggle (Created/Updated/history fields
 * belong "behind disclosure — expand row or drawer, never a column").
 *
 * Primary/Secondary column tiers (COMPONENT_INVENTORY.md) need no component:
 * Secondary columns are already visible at desktop *and* laptop and only
 * disappear when `ResponsiveTable` swaps the whole table for cards at the
 * tablet breakpoint — that's an existing CSS media query, not new work.
 * Some screens choose to hide a Secondary column earlier, at laptop, for
 * space (e.g. Supervisor Team's Variance/Department per
 * RESPONSIVE_GUIDELINES.md) — that's a per-screen call, not a generic rule,
 * so it's left to that screen's own `className`/media query rather than
 * forced through here.
 */
export type SortDirection = "asc" | "desc";
export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

/** Click behavior for a sortable header: none → asc → desc → none. */
export function toggleSort<K extends string>(current: SortState<K> | null, key: K): SortState<K> | null {
  if (!current || current.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return null;
}

export function SortableTh<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  label: ReactNode;
  sortKey: K;
  sort: SortState<K> | null;
  onSort: (key: K) => void;
  align?: "right";
}) {
  const active = sort?.key === sortKey;
  const ariaSort = active ? (sort!.direction === "asc" ? "ascending" : "descending") : "none";
  return (
    <th className={align === "right" ? "num" : undefined} aria-sort={ariaSort}>
      <button type="button" className="dt-sort-btn" onClick={() => onSort(sortKey)}>
        {label}
        {active && <span aria-hidden="true">{sort!.direction === "asc" ? " ▲" : " ▼"}</span>}
      </button>
    </th>
  );
}

/** Focusable disclosure toggle for a row's Detail-tier fields. */
export function RowExpandButton({ expanded, onToggle, label }: { expanded: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className="dt-expand-btn" aria-expanded={expanded} aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`} onClick={onToggle}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ transform: expanded ? "rotate(90deg)" : undefined, transition: "transform .15s" }}>
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}
