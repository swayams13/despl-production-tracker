# Handoff: DESPL Tracker — Phase 4 Design Hardening

## Overview
DESPL Tracker is a production-tracking application for a fabrication/welding
operation: activity execution (My Day), supervision (Team), QC/hold points,
project scheduling, and multi-level analytics (Management → Portfolio →
Project → Department → Bottleneck) with a reporting layer. This bundle is the
result of a 4-round design process (Rounds 1–3 built the approved screens;
Phase 4 is a design-system + UX hardening pass over those screens — no new
screens, same information architecture). It is the spec for production
implementation ("Phase 5").

## About the design files
Everything in `mockups/` is a **design reference built in HTML** — static,
self-contained prototypes showing intended layout, color, type, states and
interaction, not production code to copy directly. They use a lightweight
templating runtime (`support.js`) that only exists to drive the preview; do
not port it. **The task is to recreate these designs in the target
codebase's real environment** (React/Vue/whatever stack the DESPL Tracker
repo already uses — a Next.js/Prisma app per the attached codebase) using its
existing component patterns, data layer, and routing — not to embed or lightly
adapt the HTML.

## Fidelity
**High-fidelity.** Colors, type, spacing and states are final and specified
exactly in `DESIGN_SYSTEM.md` (tokens) and `COMPONENT_INVENTORY.md`
(component contracts). Recreate pixel-accurately using the values given, not
approximated from the screenshots.

## What Phase 4 added on top of Rounds 1–3
Rounds 1–3 already defined the approved screens (list below). Phase 4 did not
redesign them — it audited them for consistency and specified the states that
didn't exist yet as designed patterns:
- Canonical design tokens and one component set (no per-screen variants) —
  `DESIGN_SYSTEM.md`
- Component inventory + table column-tier rules (Primary/Secondary/Detail) —
  `COMPONENT_INVENTORY.md`
- Desktop/laptop/tablet responsive behavior for the 5 priority screens —
  `RESPONSIVE_GUIDELINES.md`
- Accessibility requirements (contrast — audited and passing; keyboard/focus/
  ARIA — specified as build requirements since the mockups are static) —
  `ACCESSIBILITY_AUDIT.md`
- Empty, loading, error, toast/mutation-feedback and confirmation-dialog
  states, plus a screen-by-screen purpose/action review — `UX_FINAL_REVIEW.md`

**Read these five docs before implementing anything** — they are the actual
spec; the screen-by-screen section below is a map into them plus the mockup
files, not a replacement.

## Screens / views
Each entry names the file and the `data-screen-label` to find it by. Full
component-level detail (colors, spacing, states) is in the design-system docs,
referenced per screen below rather than repeated.

### Round 1 — `mockups/DESPL Round 1.dc.html`
| Screen | Label | Purpose | Primary user |
|---|---|---|---|
| Employee My Day | `01 Employee — My Day` | Today's personal work queue | Production employee |
| Supervisor My Day | `02 Supervisor — My Day` | Supervisor's own queue + team signal | Supervisor |
| Supervisor Team | `03 Supervisor — Team` | Whose work needs a decision | Supervisor |
| Management Dashboard | `04 Management — Dashboard` | Where to intervene today | Management |

### Round 2 — `mockups/DESPL Round 2.dc.html`
| Screen | Label | Purpose |
|---|---|---|
| Project Control Centre | `01 Project Control Centre` | Single project health, tab strip into Timeline/BOM/QCP etc. |
| Project Schedule (Gantt) | `02 Project Schedule` | Rolled-up timeline across units, process grain |
| Activity Detail | `03 Activity Detail` | Execute/progress one unit×stage; state-driven primary action |
| Department Overview | `04 Department Overview` | One department's people + active work across projects |
| Supervisor Team | `05 Supervisor Team` | (see Round 1 Team — same screen, project-scoped variant) |
| QC & Hold Points | `07 QC and Hold Points` | QC queue: awaiting verification, overdue, on hold |
| QC Detail | `08 QC Detail` | One inspection record; verify/reject |
| Welding / Production | `09 Welding Production` | Shift-level production/welding workflow |
| Tablet — production floor | `10 Tablet — production floor` | Same Activity Detail / QC Detail / My Day, tablet layout reference |
| States | `11 States` | One activity row shown across its ten status conditions — the status-language reference |

### Round 3 — `mockups/DESPL Round 3.dc.html`
| Screen | Label | Purpose |
|---|---|---|
| Management Dashboard | `01 Management Dashboard` | "Where should management intervene?" |
| Portfolio Analysis | `02 Portfolio Analysis` | Cross-project trend + full hierarchy |
| Project Analytics | `03 Project Analytics` | Single-project analytics depth |
| Department Analytics | `04 Department Analytics` | Department performance across all active projects |
| Schedule Performance | `05 Schedule Performance` | Planned vs actual cumulative completion (S-curve) |
| Bottleneck Analysis | `06 Bottleneck Analysis` | Which department is creating the most delay, portfolio-wide |
| Reports | `07 Reports` | Report index, organized by decision, not alphabetically |
| Report Detail | `08 Report Detail` | One report's filtered, exportable table |
| Sunburst vs alternative | `09 Sunburst vs alternative` | Design-rationale screen — chart chosen vs rejected (reference only, not a product screen to build as-is) |
| Drill-down model | `10 Drill-down experience` | Reference screen documenting the universal drill-down chain |

The five **priority screens** for Phase 4's responsive/state hardening — My
Day (Employee), Activity Detail, Supervisor Team, Management Dashboard,
Project Control Centre — have explicit desktop/laptop/tablet specs in
`RESPONSIVE_GUIDELINES.md` and full purpose/action tables in
`UX_FINAL_REVIEW.md` §20. Treat the other screens as governed by the same
system (tokens, components, table tiers) even though they weren't individually
re-specified.

## Interactions & behavior
- **Status model**: 10 statuses (Not Started, In Progress, Waiting, Blocked,
  Overdue, At Risk, Completed, Rejected, On Hold) — see the "States" screen
  (Round 2, label 11) for every visual permutation on one row. Always
  label + colored dot, never color alone.
- **Activity primary action** is state-driven: Start → Update → Complete
  (never more than one primary button visible at once). See Activity Detail
  mockup + `UX_FINAL_REVIEW.md` §7/§16.
- **Confirmation matrix** (which actions need a dialog, what consequence
  text, whether a reason is required, whether it's audited) — full table in
  `UX_FINAL_REVIEW.md` §16. Reassignment uses a 2-step modal (see Round 2
  Assignment flow reference in `DESIGN_DECISIONS.md`).
- **Toasts**: fire on every completed mutation (e.g. "Activity completed.",
  "Assignment updated.") — bottom-right, `status-healthy` left bar,
  auto-dismiss 4s. Failures are inline, not toasted, and never clear the
  user's input. Spec + exact copy in `UX_FINAL_REVIEW.md` §11.
- **Empty/loading/error states**: exact copy per screen in
  `UX_FINAL_REVIEW.md` §8–§10. Loading is always local/per-panel
  (skeletons matching card/row geometry) — never a full-screen spinner.
- **Responsive**: reflow, never shrink text/padding below the type/spacing
  scale. Full breakpoint + per-screen behavior in `RESPONSIVE_GUIDELINES.md`.
- **Global project selector** (`[ DESPL-320 · Pressure Vessel ▼ ]`) persists
  across project-scoped screens (Control Centre, Schedule, Department-on-
  project, Activity Detail) and does not apply to portfolio-level screens
  (My Day, Team, Dashboard). See `UX_FINAL_REVIEW.md` §14.

## State management
- Role/screen switching in the mockups is driven by simple boolean flags
  (`isInd`, `isSup`, `isTeam`, `isMgmt`, etc.) purely for prototype
  navigation — in production this maps to real route-based navigation +
  role-based access control, not a client-side flag.
- Real state needed: current user + role, selected project/scope (persisted
  per §14 above), per-screen filter/sort/pagination state, table column
  visibility (Reports only, per `COMPONENT_INVENTORY.md`), toast queue,
  loading/error state per panel (independent per panel, not page-wide).
- Data fetching should follow the per-panel independence called out in
  `UX_FINAL_REVIEW.md` §9 — one slow panel must not block sibling panels on
  the same screen from rendering.

## Design tokens
Full token tables (color, type scale, spacing, radius, shadow) are in
`DESIGN_SYSTEM.md` — do not re-derive these from screenshots; the hex values
and px values there are the canon. Highlights:
- Fonts: Inter (UI) + JetBrains Mono (all numbers/IDs/statuses/timestamps)
- Surfaces: `#0b0c0e` canvas / `#141619` panel / `#1c1f24` raised
- Text: `#e7e9ec` primary / `#8b919a` muted
- Accent (interactive only): `#ff7a1a`
- Status: critical `#f0524d`, warning `#d9a62e`, healthy `#3fb950`, info `#4c8dff`
- No gradients, no glassmorphism, no card shadows beyond shell/dropdown
  elevation, nothing rounded past 8px.

## Assets
No image/icon assets — all icons in the mockups are inline SVG (stroke-based,
`currentColor`), no icon font or external asset dependency. Google Fonts CDN
links for Inter + JetBrains Mono are in each mockup's `<head>`; production
should self-host or use the codebase's existing font-loading approach.

## Screenshots
`screenshots/` contains a PNG of every screen listed above, named
`round<N>-<##>-<screen>.png` matching the tables in this README exactly (e.g.
`round2-03-activity-detail.png`). Reference images only — implement from the
live `.dc.html` mockups (colors/spacing are exact there) and the design-
system docs, not by eyeballing the PNGs.

## Files in this bundle
- `mockups/DESPL Round 1.dc.html` — Employee/Supervisor/Management core screens
- `mockups/DESPL Round 2.dc.html` — Project, Activity, Department, QC, Production screens
- `mockups/DESPL Round 3.dc.html` — Analytics, Reports, drill-down screens
- `DESIGN_SYSTEM.md` — tokens + canonical components
- `COMPONENT_INVENTORY.md` — component-by-component inventory and table rules
- `RESPONSIVE_GUIDELINES.md` — breakpoints and per-screen responsive behavior
- `ACCESSIBILITY_AUDIT.md` — contrast results + keyboard/ARIA/focus requirements
- `UX_FINAL_REVIEW.md` — empty/loading/error/toast states, confirmation matrix, demo scenarios, screen-by-screen review
- `DESIGN_DECISIONS.md` — running design-decision log across all rounds (why choices were made, what was deliberately cut)
- `screenshots/` — one PNG per screen (25 total), see "Screenshots" above

Open the `.dc.html` files directly in a browser to view/interact with the
mockups; they are self-contained aside from the Google Fonts CDN call.
