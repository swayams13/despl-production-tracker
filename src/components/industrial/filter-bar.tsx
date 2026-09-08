"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Accessible single-select dropdown (COMPONENT_INVENTORY.md's FilterBar
 * building block). Generalizes my-day/_project-filter.tsx's `ProjectFilter` —
 * that file's own docstring flags it as "the first dropdown in the codebase
 * with [keyboard/Escape/aria-expanded/aria-controls] — a candidate to
 * consolidate into a shared primitive if one gets built later, not the other
 * way round." This is that primitive; `ProjectFilter` is left as-is (not
 * forced onto it this session — out of scope for Step 1).
 */
export function Dropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: Array<{ value: string; label: string; count?: number }>;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const select = (v: string | null) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? selected.label : label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ marginLeft: 6 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={listId} role="listbox" className="drop" style={{ left: 0, right: "auto", top: "calc(100% + 4px)", minWidth: 200 }}>
          <div
            role="option"
            aria-selected={value === null}
            className="d-row"
            style={{ cursor: "pointer", fontWeight: value === null ? 600 : undefined }}
            onClick={() => select(null)}
          >
            {label}
          </div>
          {options.map((o) => (
            <div
              key={o.value}
              role="option"
              aria-selected={value === o.value}
              className="d-row"
              style={{ cursor: "pointer", fontWeight: value === o.value ? 600 : undefined }}
              onClick={() => select(o.value)}
            >
              {o.label}
              {o.count !== undefined && <small>{o.count}</small>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Canonical FilterBar (DESIGN_SYSTEM.md §2): one row, primary filters left,
 * search right, advanced filters collapse behind "More filters" — never a
 * second permanent row. Dismissible active-filter chips (the orange
 * `.filter-chip`, already shipped for cross-filter navigation from KPI
 * cards/matrix cells) render above the controls row when present.
 */
export function FilterBar({
  chips,
  filters,
  search,
  moreFilters,
}: {
  /** Dismissible active-filter chips, e.g. from a KPI-card deep link. */
  chips?: Array<{ key: string; label: string; onRemove: () => void }>;
  /** Primary filter controls (Dropdown, etc.), left-aligned. */
  filters?: ReactNode;
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
  /** Advanced filters, collapsed behind the "More filters" toggle. */
  moreFilters?: ReactNode;
}) {
  const [showMore, setShowMore] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      {chips && chips.length > 0 && (
        <div className="sumchips" style={{ marginBottom: 8 }}>
          {chips.map((c) => (
            <span key={c.key} className="filter-chip">
              {c.label}
              <button type="button" aria-label={`Remove filter: ${c.label}`} onClick={c.onRemove}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {filters}
        {moreFilters && (
          <button type="button" className="btn" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>
            More filters
          </button>
        )}
        {search && (
          <input
            className="ws-detail"
            style={{ marginLeft: "auto", maxWidth: 240 }}
            type="search"
            value={search.value}
            placeholder={search.placeholder ?? "Search…"}
            onChange={(e) => search.onChange(e.target.value)}
            aria-label={search.placeholder ?? "Search"}
          />
        )}
      </div>
      {showMore && moreFilters && (
        <div className="card" style={{ marginTop: 8, padding: 12 }}>
          {moreFilters}
        </div>
      )}
    </div>
  );
}
