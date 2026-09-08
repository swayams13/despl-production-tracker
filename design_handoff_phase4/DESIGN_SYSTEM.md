# DESPL Tracker — Design System
Phase 4 hardening. Codifies what Rounds 1–3 already built — no new colors, fonts, or components introduced. Brief §1, §2, §5, §17.

## 1. Foundations

**Typeface:** Inter (UI text, labels, headings) + JetBrains Mono (all numbers, IDs, statuses, timestamps — anything the eye scans for a value). This pairing is already used on every screen; keep it exclusive. Do not introduce a third font.

**Type scale** (as used, not rounded to a "clean" scale — the half-steps are deliberate, they read as instrument-panel precision, not sloppiness):
| Token | Size | Weight | Use |
|---|---|---|---|
| `text-2xl` | 20px | 600 | Page title (h1) |
| `text-lg` | 15–16px | 600 | Section/card title, JetBrains numeric hero (24px for KPI values) |
| `text-base` | 13px | 400 | Body copy, table cells |
| `text-sm` | 12–12.5px | 400–500 | Secondary line, tab labels, breadcrumb |
| `text-xs` | 10.5–11.5px | 500–600 | Metadata, badges, column headers (uppercase, letter-spacing .8–1.2px) |
| `text-2xs` | 10px | 600 | Nav section headers (uppercase) |

Never below 10px anywhere. Column headers, badges and nav labels use uppercase + letter-spacing instead of size reduction to stay legible at small sizes.

**Color tokens** (hex values are the canon; give them names so engineering can bind CSS vars):
| Token | Hex | Role |
|---|---|---|
| `--surface-canvas` | `#0b0c0e` | App background, deepest layer |
| `--surface-panel` | `#141619` | Cards, table headers, top strip, dropdowns |
| `--surface-raised` | `#1c1f24` | Hover fill, avatar chips, progress-track fill |
| `--border-default` | `#262a30` | All hairlines — card, table row, divider |
| `--border-outer` | `#2e3034` | Shell outer border only |
| `--text-primary` | `#e7e9ec` | Body text, values |
| `--text-muted` | `#8b919a` | Labels, metadata, secondary lines |
| `--accent` | `#ff7a1a` | The ONE interactive/brand color — links, active nav, primary CTA, "click here" |
| `--status-critical` | `#f0524d` | Delayed / overdue / rejected / destructive |
| `--status-warning` | `#d9a62e` | At risk / on hold / warning |
| `--status-healthy` | `#3fb950` | On track / completed / success |
| `--status-info` | `#4c8dff` | In progress / actual-vs-planned data series |

Rule carried from Round 3: `--accent` is reserved for things you can click. A number is never orange just because it's important — that's what the status colors are for. This is the single biggest discipline check in visual QA (§18).

**No gradients, no glass, no drop-shadow-heavy cards.** The only shadow in the system is the shell's outer elevation (`0 24px 60px rgba(0,0,0,.5)`) and dropdown panels (`0 10px 30px rgba(0,0,0,.55)`). Component-level shadows are not used — flat panels + hairline borders carry all separation.

**Spacing:** 2px-based, not 4px/8px — matches the type scale's half-steps. Common values in use: 4, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 26px. Pick from this set; don't invent 15px or 13px paddings.

**Radius:**
| Token | px | Use |
|---|---|---|
| `radius-sm` | 2px | Progress bar track/fill only |
| `radius-md` | 4px | Buttons, tab chips, top-strip toggles |
| `radius-lg` | 6px | Cards, panels, nav items, table containers |
| `radius-xl` | 8px | App shell, dropdown panels |
| `radius-pill` | 8–10px | Status badges, count chips |

Never round a card past 8px — this is an industrial tool, not a consumer app. Pills are the only fully-rounded shape.

## 2. Canonical components

One version of each. Variants exist only where the product has a real reason (noted).

- **Button** — height 32px, `radius-md`, `padding: 0 12px`, `font: 500 12px Inter`. Three variants only: *Primary* (accent fill, `#0b0c0e` text — reserved for the one action per screen that matters, e.g. Start/Update/Complete on Activity Detail), *Secondary* (surface-panel fill, border-default, text-primary — the default), *Ghost/Icon* (transparent, text-muted, for toolbar icons). No size variants outside the tablet touch-target override (§ Responsive Guidelines).
- **StatusBadge** — pill, `padding:3px 8px`, `radius-pill`, `font:600 10.5px Inter`, background = status color at ~12–16% opacity, text/dot = full-opacity status color. Always label + colored dot, never dot alone (§5, §12).
- **DataTable** — see COMPONENT_INVENTORY.md and §4 rules below.
- **MetricCard** — `background:panel; border:1px solid border-default; border-top:2px solid <status or accent>; radius-lg; padding:13px 15px`. Label (text-2xs, uppercase, muted) over value (JetBrains 24px). One card = one number. Never two metrics stacked in one card.
- **ActivityCard** (tablet) — full-width row, 52–82px touch height, status stripe left edge, single primary action button right-aligned. Used in place of DataTable rows below the tablet breakpoint.
- **PageHeader** — title (h1, 20px/600) + one-line subtitle answering "what does this screen tell me" (text-muted, 12px) + right-aligned action cluster (filters, then buttons, then a muted timestamp). Every screen in Rounds 1–3 already follows this shape; §13 makes it mandatory, not incidental.
- **FilterBar** — one row: primary filter chips/dropdowns left, search right, `padding` matches PageHeader's action cluster. Advanced filters collapse behind a "More filters" button, never a second permanent row (§15).
- **Tabs** (project sub-nav) — underline style, `border-bottom:2px solid <accent or transparent>`, `padding:8px 12px`, horizontal-scroll on overflow, never wrap to a second line.
- **Modal / Dialog** — centered, `background:panel`, `radius-lg`, header + body + right-aligned action row (Cancel = secondary button, Confirm = primary or `status-critical` fill for destructive). See UX_FINAL_REVIEW.md §16 for which actions require one.
- **Drawer** (right rail) — used for detail-without-navigation (row expansion detail, QC evidence). Slides from the right, same panel background, `border-left:1px solid border-default`.
- **Toast** — bottom-right stack, `background:panel`, `border-left:3px solid <status color>`, icon + one line + optional "Undo"/"View" link. Auto-dismiss 4s for confirmations, persists until dismissed for errors.
- **Tooltip** — dark panel, 11px text, used only for icon-only buttons and truncated text — never to hide primary information.
- **Nav (sidebar)** — 224–236px, section headers (2xs uppercase) grouping items, active item = `surface-raised` fill + 2px accent left border. Identical shape across all four roles; only the item list changes.
- **Breadcrumb** — `crumbRoot / **crumbLeaf**`, muted → primary-bold, sits in the 48px sub-header alongside date and notification bell. Present on every screen (§13).

## Explicitly rejected
Per brief §2: no decorative gradients, no glassmorphism, no card shadows beyond the shell/dropdown elevation, no rounding past 8px, no fourth typeface, no fourth chart grammar (Round 3 already ruled this out for Sunburst — stays ruled out).
