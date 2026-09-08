/**
 * Canonical Tabs (DESIGN_SYSTEM.md §2: underline style, horizontal-scroll on
 * overflow, never wraps). Wraps the `.tabs`/`.tab`/`.tab.on` classes already
 * used identically on jobs/[id] (9 tabs), my-day (6 tabs) and command/[dept]
 * (pipeline columns) — same markup, typed. URL-driven by design (real
 * `<Link>`s, not a client useState toggle) so state survives refresh/back,
 * per README's cross-filter-navigation rule; a real anchor is also already
 * keyboard-reachable/operable via Enter, closing ACCESSIBILITY_AUDIT.md's
 * "table/tab row must be a real focusable element, not a div onClick" gap
 * for this component without extra work.
 */
import Link from "next/link";

export function Tabs({ items }: { items: Array<{ key: string; label: string; href: string; active: boolean }> }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <Link key={item.key} href={item.href} role="tab" aria-selected={item.active} className={`tab${item.active ? " on" : ""}`}>
          {item.label}
        </Link>
      ))}
    </div>
  );
}
