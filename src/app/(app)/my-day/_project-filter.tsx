"use client";

import { useEffect, useId, useRef, useState } from "react";

/** Distinct job numbers present in `rows`, each with its row count, sorted alphabetically. Pure — no component test infra exists in this repo, so this is the unit-testable slice of S13a's filter logic. */
export function groupByJobNumber(rows: Array<{ jobNumber: string }>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.jobNumber, (counts.get(r.jobNumber) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * S13a — client-side project filter for My Day's "Department pool" section.
 * No server round trip: narrows an already-fetched row array by job number.
 *
 * Reuses the topbar job-switcher's `.drop`/`.d-row` idiom (app-shell.tsx) and
 * `jobs/new/_client.tsx`'s `ClientPicker` outside-click pattern, but neither
 * of those is actually accessible (no keyboard operation, no Escape, no
 * aria-expanded/aria-controls — confirmed via repo-wide search, this is the
 * first dropdown in the codebase with all four). Do not regress this one to
 * match them; if a shared accessible dropdown primitive gets built later,
 * this is a candidate to consolidate into it, not the other way round.
 */
export function ProjectFilter({
  options,
  value,
  onChange,
}: {
  /** [jobNumber, count] pairs, in display order. */
  options: Array<[string, number]>;
  value: string | null;
  onChange: (jobNumber: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();

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

  const total = options.reduce((sum, [, count]) => sum + count, 0);
  const label = value ?? "All projects";

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
        {label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ marginLeft: 6 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={listId} role="listbox" className="drop" style={{ left: 0, right: "auto", top: "calc(100% + 4px)", minWidth: 220 }}>
          <div
            role="option"
            aria-selected={value === null}
            className="d-row"
            style={{ cursor: "pointer", fontWeight: value === null ? 600 : undefined }}
            onClick={() => select(null)}
          >
            All projects<small>{total}</small>
          </div>
          {options.map(([jobNumber, count]) => (
            <div
              key={jobNumber}
              role="option"
              aria-selected={value === jobNumber}
              className="d-row"
              style={{ cursor: "pointer", fontWeight: value === jobNumber ? 600 : undefined }}
              onClick={() => select(jobNumber)}
            >
              <span className="mono">{jobNumber}</span>
              <small>{count}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
