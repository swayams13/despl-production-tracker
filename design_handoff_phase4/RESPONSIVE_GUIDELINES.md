# Responsive Guidelines — DESPL Tracker
Brief §6, §7. Primary target desktop enterprise workstation; secondary tablet on the production floor. Phone is explicitly out of scope (carried over from Round 2).

## Breakpoints
| Breakpoint | Width | Shell behavior |
|---|---|---|
| Desktop | ≥1440px | Full shell as built: 224–236px sidebar, 1280–1360px content, all secondary columns visible. |
| Laptop | 1024–1439px | Sidebar collapses to icon-only (48px, labels on hover/tooltip); content reflows to available width; Secondary-tier table columns (Stage, Department, Variance) stay but grid gaps tighten from the 2px spacing scale's larger steps to its smaller ones. |
| Tablet | 768–1023px, landscape assumed (per Round 2's tablet screen) | Sidebar becomes a bottom or top icon bar; tables convert to ActivityCards (see below); touch targets grow; typing is minimized. |

Nothing below 768px is designed — a phone user is told to use a tablet or desktop (this is a shop-floor and office tool, not a consumer app).

## Rule: reflow, don't shrink
Never respond to a narrower viewport by reducing font size or padding below the scale in DESIGN_SYSTEM.md. Always reflow: drop a column, stack a grid, convert a table to cards, collapse a sidebar. A 10px table cell on a laptop is a bug, not a fix.

## Per-screen guidance (priority screens)

**My Day (Employee)** — Desktop: two-column (queue list + detail panel or KPI strip). Laptop: single column, KPI strip becomes a horizontal scroll of MetricCards. Tablet: full ActivityCard list, no detail panel — tapping a card navigates to Activity Detail rather than opening inline, since screen width can't hold both.

**Activity Detail** — Desktop: content + right rail (Detail-tier fields, history) side by side. Laptop: right rail moves below the primary content, still visible without a click. Tablet: right rail becomes a collapsed "Details" disclosure below the primary action; the primary action button is full-width, 56px minimum height, pinned above the fold — this is the screen §7 calls out by name (Start/Update/Complete must never require scrolling to find).

**Supervisor Team** — Desktop: DataTable, all tiers visible. Laptop: Variance and Department columns drop to an expand-row. Tablet: converts fully to ActivityCards grouped by employee, with the employee's load shown as a compact stat rather than a table row; reassignment opens the same 2-step modal, sized full-screen on tablet rather than centered.

**Management Dashboard** — Desktop: 5-column MetricCard grid + health table. Laptop: MetricCard grid becomes 2×3 (wraps), health table keeps all columns (it's read-heavy, not touch-heavy, so tablet conversion matters less here than write-heavy screens). Tablet: MetricCard grid becomes a horizontal scroll strip; health table converts to stacked cards, one project per card, tap to drill in — matches the drill-down model in DESIGN_DECISIONS.md rather than inventing a tablet-only shortcut.

**Project Control Centre** — Desktop: two-column KPI/schedule-health panels + tab strip. Laptop: panels stack vertically in original order (schedule health, then exceptions). Tablet: tab strip becomes a horizontal-scroll pill row (already scrollable per the existing `overflow-x:auto`); KPI strip becomes 2 cards per row.

## Touch targets (tablet, §7)
- Minimum 44×44px for any tappable control; primary actions (Start/Update/Complete, Verify/Reject) sized 52–82px per Round 2's tablet precedent.
- No control relies on hover — hover-only affordances (row highlight, tooltip-triggered info) get a tap-visible equivalent or are promoted to always-visible on tablet.
- Forms minimize typing: reason selection is a picker list (already the pattern for delay/assignment reasons), never a free-text-first field; free text is optional and secondary.
- Modal chains are capped at the existing 2-step pattern; no 3+ step tablet flow.

## What was NOT changed
Round 1–3's 1280–1360px desktop layouts are the source of truth and are unchanged by this pass — this document adds the laptop/tablet response on top, it does not redesign desktop.
