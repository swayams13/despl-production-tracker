import type { ReactNode } from "react";

/**
 * Structural breakpoint primitive (SPEC §3.3): a real `<table>` at
 * `min-width: 1024px`, a card list below it — nothing else. It owns only the
 * CSS swap (`.rt-table` / `.rt-cards` in globals.css, media-query driven) and
 * never a JS `useState`/`matchMedia` toggle — the server doesn't know
 * viewport width, so a JS-driven swap would hydration-mismatch and flash.
 *
 * Deliberately not a column-config/cell-renderer grid: the tables it wraps
 * have heterogeneous, stateful rows (delay-reason selects, role-gated
 * actions, maker-checker read-only rendering). Callers author their own
 * `<table>` markup and their own card markup; this component only decides
 * which one the browser shows.
 */
export function ResponsiveTable({ table, cards }: { table: ReactNode; cards: ReactNode }) {
  return (
    <>
      <div className="rt-table">{table}</div>
      <div className="rt-cards">{cards}</div>
    </>
  );
}
