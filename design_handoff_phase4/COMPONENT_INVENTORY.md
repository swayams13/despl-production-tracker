# Component Inventory — DESPL Tracker
Every reusable primitive found across Round 1–3, its canonical form, and where duplicates were found and merged. Brief §1, §4.

## Inventory

| Component | Found in | Variants found | Canonical decision |
|---|---|---|---|
| Button | All screens | Tab-toggle button, top-strip switcher button, filter-dropdown button, form-modal button — all already share height/radius/font | **One Button**, 3 variants (Primary/Secondary/Ghost) per DESIGN_SYSTEM.md. No merge needed — already consistent. |
| StatusBadge | Nav badges, table status column, health chips, QC state chips | Count-chip (numeric, orange/red) vs status-chip (label, colored dot) are two different jobs | **Two canonical types**, both documented: `CountBadge` (badge count only, no dot) and `StatusBadge` (label+dot). Do not use CountBadge where a status is being shown. |
| DataTable | Schedule, Department, QC queues, Reports, Bottleneck drill-down | Row density differs slightly (52px on Schedule, 44px on Reports list) | **One DataTable**, density is a prop (`comfortable` 52px default, `compact` 44px for long reference lists only — Reports index, audit history). Sorting/filter/pagination chrome identical everywhere. |
| MetricCard | Management Dashboard tiles, Project stat strip, Department cards | Some cards show a trend arrow, most don't | **One MetricCard**; trend arrow is an optional slot, not a separate component. |
| Card (generic panel) | Schedule health panel, QC hold-point card, Bottleneck legend | Consistent already: panel bg, border-default, radius-lg | Canonical, no changes. |
| ProgressBar | Schedule health, Activity Detail progress, S-curve reference line | Two forms: filled bar w/ planned-line tick, and the S-curve chart | Both kept — S-curve is a chart, not a progress bar; do not collapse them. |
| Tabs (project sub-nav) | Project Control Centre, Schedule, QC | Identical | Canonical, no changes. |
| Nav sidebar | All 4 roles | Item list differs by role; shape identical | Canonical — this is the "one system" proof point, keep enforcing it in review. |
| PageHeader | Every screen | Management screens add a scope dropdown (All projects / Last 30 days) that operational screens don't | Canonical `PageHeader` + optional `scopeFilters` slot — not a separate header for analytics screens. |
| FilterBar | Report Detail, Portfolio trend range chips | Report Detail has 4 filters, Portfolio has 1 range chip row | Same component, filter count is data-driven, not a variant. |
| Modal — 2-step (Assignment) | Assignment/Reassignment flow | Only one two-step modal exists | Canonical shape for any future multi-step confirmation (e.g. Reject with reason should follow this shape, not invent a new one). |
| Drawer (row expansion / right rail) | Schedule expanded row, Activity Detail right rail, QC Detail right rail | Consistent | Canonical, no changes. |
| Toast | *Not yet built in R1–3 mockups* | — | **New in Phase 4** — see DESIGN_SYSTEM.md; needed for §11 mutation feedback. |
| Empty state | *Only implied, not fully designed in R1–3 screen 11* | — | **New in Phase 4** — see UX_FINAL_REVIEW.md §8. |
| Loading/skeleton state | *Not yet built* | — | **New in Phase 4** — see UX_FINAL_REVIEW.md §9. |
| Error state | *Not yet built* | — | **New in Phase 4** — see UX_FINAL_REVIEW.md §10. |
| Confirmation dialog (destructive) | *Not yet built as a distinct pattern* | Assignment's 2-step modal is the closest precedent | **New in Phase 4**, built on the Modal component — see UX_FINAL_REVIEW.md §16. |

## Table system rules (brief §4)

Column priority, applied to every DataTable instance:

- **Primary (always visible):** Activity/identity, Project, Status, Due, Owner.
- **Secondary (visible when it earns the space, i.e. desktop/laptop, dropped first on tablet):** Stage, Department, Variance.
- **Detail (behind disclosure — expand row or drawer, never a column):** Created, Updated, History, Metadata, per-unit split, evidence.

Every table supports, where the data volume justifies it: sort (column header click), filter (via FilterBar, not per-column popovers), search (FilterBar), pagination or "load more" past 50 rows, column visibility only on Reports (operational tables have a fixed, reviewed column set — hiding columns on a QC queue is a way to accidentally hide a status), row expansion for Detail-tier fields, a sticky identity column when the table scrolls horizontally (should be rare — Round 2's rule against horizontal scroll at 1280px still holds; only Reports' widest exports may need it).

No table exposes a raw database field. If a column name would need `ProcessPlanStatus` or `stage_id` to explain, it is either renamed to the terminology in DESIGN_DECISIONS.md or removed.
