# 18 — DESIGN SYSTEM

*Preserve the industrial control-room aesthetic. Reduce what competes; increase
what guides. The visual language is good — it is applied at a density calibrated
for a desktop mockup, not for a workshop.*

---

## 1. The rule this document exists to enforce

> **Never solve density by making typography tiny.**

Every density problem in this audit has a column-count answer, a
progressive-disclosure answer, or a "this belongs on a different surface" answer.
Font size is never the answer, and it has been used as one in 129 places.

---

## 2. What to keep, unchanged

The aesthetic direction is right and should not be re-litigated:

- **Dark industrial control-room palette.** `--bg` #0B0C0E through `--surface-2`
  #1C1F24, `--text` #E7E9EC, `--muted` #8B919A, `--accent` #FF7A1A used sparingly.
- **Status as the only colour vocabulary**, expressed through three redundant
  channels — tinted pill, solid dot, **text label**, plus a per-status SVG glyph
  on coarse pointers, plus distinct *shapes* for overdue and rejected markers.
  This is better than most design systems manage.
- **The Stage Spine.** A domain-native encoding of a 25-stage route in one
  horizontal bar, mini on every row and full-size on the job page. It is the best
  idea in the visual language.
- **JetBrains Mono with `tabular-nums` for all numeric data.** Numbers align
  vertically in every table.
- **Three palettes including a purpose-built outdoor high-contrast one**, stored
  per user in the database.
- **`prefers-reduced-motion` honoured** for every CSS animation.
- **`ResponsiveTable`'s CSS-only breakpoint swap.** The reasoning is documented
  and correct — a JS/`matchMedia` toggle would hydration-mismatch and flash. The
  defect is nesting two of them (AUD-045), not the primitive.
- **The `.skel` shimmer** already exists with reduced-motion support. It is not
  used on the six slowest routes; use it.

---

## 3. Token changes

### 3.1 Contrast — AUD-066, AUD-102

| Token | Current | Change to | Why |
|---|---|---|---|
| `--border` | #262A30 | **#3A4048** (or #3D444D for margin) | 1.15:1 → 3.03:1 against `--surface-2`. Fails 1.4.11 today on every button, input, card and table separator |
| `--s-idle` | #4A4F57 | **#5C6068** (or #606670) | 2.20:1 → 3.02:1. Confirmed by the team's own `test.fixme` |
| Chip tint on `--surface-2` | 12% | **6%**, or `color-mix` toward `--bg` | Restores `.c-progress`, `.c-submitted`, `.c-overdue` above 4.5:1 |

The visual change from #262A30 to #3A4048 is small. These are the two highest
value-per-effort changes in the entire audit.

### 3.2 Typography floor — AUD-054

**No text below 11px on any surface. No text below 12px under
`@media (pointer: coarse)`.**

| Selector | Current | Fine pointer | Coarse pointer |
|---|---|---|---|
| `.chip` | 10.5px | **11px** | **12px** (currently 11.5) |
| `.kpi h6` | 10.5px | **11px** | 12px |
| `.stat h6` | 10px | **11px** | 12px |
| `th` | 10.5px | **11px** | 12px |
| `.rail-item span` | **9.5px** | **11px**, or icon-only with an accessible name and a wider rail (76 → 88px) | 12px |
| `.bell em`, `.bn-badge` | **9px** | **11px** in a slightly larger pill | 12px |
| `.week-cell .dy`, `.bars .b span` | 10px | **11px** | 12px |
| `.g-actual b`, `.g-todaylab` | **9px** | **11px** | 12px |
| Units × stage matrix headers | **9px inline** | **11px** | 12px |
| QC yield week labels | **9px inline** | **11px** | 12px |
| Welding sparkline caption | **10px inline** | delete the sparkline (AUD-112) | — |

**Replace the 69 inline `fontSize:` literals with utility classes.** Inline
styles bypass every media query, so the coarse-pointer density layer currently
cannot reach any of them — which is why the shop-floor device gets the worst
type in the product.

### 3.3 Touch targets — AUD-067

Under `@media (pointer: coarse)`, extend the existing 48px layer to cover what it
currently misses:

```css
.theme-industrial .spine > *  { min-height: 44px; }   /* fill drawn as an inset ::before */
.theme-industrial .uxs .cell  { position: relative; }
.theme-industrial .uxs .cell::before { content:""; position:absolute; inset:-14px; }
.theme-industrial .mx-cell    { min-height: 44px; }
.theme-industrial .chip[role="button"] { min-height: 44px; }
```

**The visual bar stays 14px; the hit area becomes 44px.** This preserves the
design exactly and is the standard technique. Also close the two gaps the team
has already disclosed: the notification bell (25×25) and the `.tab` filter
buttons (40.5px).

---

## 4. Component contract

### 4.1 Table

**Every table declares its columns as ESSENTIAL / SECONDARY / DETAIL.** Only
ESSENTIAL renders on the grid. SECONDARY and DETAIL live in an expandable row or
a detail drawer.

**Hard limits:**

| | |
|---|---|
| Columns on a grid | **6 maximum** |
| Rows before pagination | **25**, or 50 on a list-primary surface like `/jobs` |
| Identifier column | `position: sticky; left: 0` on any table wider than the viewport |
| Sortable columns | must carry `aria-sort` |
| Header cells | must carry `scope="col"` |
| Row height | 36px fine pointer, 48px coarse |
| A `<td>` whose `colSpan` varies per row | **banned** — this is why the workspace table cannot be scanned |
| A `+N more` affordance | must be a real link or filter, never a `<p>` |

The classification tables for every existing table are in `04`–`09`.

### 4.2 Row

One primary action per row. Everything else — delay-reason select, detail input,
reject-reason form — opens the **StageSheet**, which already exists, already
renders delay history and rejection history, and is already the correct terminal
destination for every drill-down in the product.

The row's primary cell contains a real `<button>` that opens the sheet
(AUD-064). The row itself carries no click handler, which also removes the twelve
`onClick={stop}` bubbling guards.

### 4.3 Card

**A card is a container for one idea.** N identical repeated cards are banned by
the project's own rules and violated in three places: `/command/[dept]`'s six
pipeline cards, `/workspace`'s N per-process cards, `/welding`'s per-welder wall.
Aggregate them into one grouped table with collapsible groups and a bulk-action
toolbar.

**Ceiling per surface: 6 card containers.** Current worst offenders:
`/command/[dept]` at 13, `/dashboard` at 11, `/my-day` at 8.

### 4.4 KPI tile

**Ceiling: 5 per surface, and every one must be clickable with filter state that
survives refresh and the back button.** The dashboard's health tiles already do
this correctly and are the reference.

A KPI tile answers "how much" for something the reader can act on. A 30-day
historical performance figure is not that, and does not belong at the top of a
work surface (AUD-042).

Current: `/dashboard` 17 (7 portfolio + 5 project + 5 stat strip), `/my-day` 4 at
the top of the page, `/command/[dept]` 3.

### 4.5 Chart

**Every chart declares the business question it answers, and that question must
end in a decision.** A chart that exists to let a reader cross-check a table they
already have is a second copy in a weaker encoding.

The chart register in `06_DASHBOARD_AUDIT.md` §9 applies this test to all 19
visualisations. Five `src/components/viz/` components are dead code while the
dashboard hand-rolls an inferior duplicate — **adopt or delete; do not leave
both.**

Requirements: labelled axes; a printed value in every matrix/heatmap cell (zero
renders as plain muted "0", no tint); an `sr-only` data table — which the S-curve
and Sunburst already do, exemplary; no arc, bar or segment that declares
`role="button"` without an activation handler.

### 4.6 Navigation

**One `NAV_ITEMS` registry. One `visibleNav(actor)` selector. Rendered into all
three chrome variants.**

```ts
type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  roles?: RoleCode[];        // omitted = all authenticated
  departmentGated?: boolean; // e.g. /welding shows only to welding-dept members
};
```

**Viewport changes presentation density only, never which destinations exist.**
The two divergent arrays are AUD-011, the highest-severity navigation defect in
the product.

### 4.7 States

Every route ships all four, and the coverage table in `15_FAILURE_MODES.md` §3
shows where they are missing:

| State | Requirement |
|---|---|
| **Loading** | `loading.tsx` rendering the real section chrome with `.skel` shimmer rows — **matching final layout**, never a full-page spinner |
| **Empty** | One sentence **plus one action**. `/alerts`'s empty state has the sentence and no action |
| **Error** | What failed + retry. Distinguish "service unavailable" (Prisma `P1001`/`P1017`) from "something went wrong" — they prompt different user actions |
| **Action feedback** | `disabled={pending}` **and** an inline refusal note carrying the stable code and its sentence. My Day's `useRun` + `RefusalNote` is the reference; extract it to `src/components/industrial/` and adopt it on every surface that currently toasts and moves on |

---

## 5. Density budget per surface

A surface that exceeds these needs a column cut or a split, not a font change.

| | Max |
|---|---|
| KPI tiles | 5 |
| Card containers | 6 |
| Tables | 2 |
| Charts | 3 |
| Columns on the largest table | 6 |
| Simultaneous competing regions | 4 |
| Smallest font | 11px (12px coarse) |

Measured today:

| Surface | Tiles | Cards | Tables | Charts | Max cols | Min font | Regions |
|---|---|---|---|---|---|---|---|
| `/dashboard` | **17** | **11** | 2 | **6** | **12** | 10.5px | — |
| `/my-day` (desktop) | 4 | **8** | 4 | 0 | 5 | 10.5px / 10px inline | **6** |
| `/my-day` (phone) | 4 collapsed | 1 + N | 0 | 0 | — | 10px / **9px** | **2** ✅ |
| `/workspace` | 0 | **N+2** | **N+2** | 0 | 6 | 10.5px | — |
| `/command/[dept]` | 3 | **13** | **9** | 1 | 4 | **10px** | **11** |
| `/jobs/[id]` Overview | 0 | 4 | 1 | 2 | **37** | **9px** | — |
| `/qc` | 0 | 5 | 1 | 2 | 6 | **9px** | — |
| `/departments` | 0 | 0 | 0 | 0 | — | 10.5px | ✅ |
| `/portal` | 0 | N | 1 | 0 | 4 | 10.5px | ✅ |

**`/my-day`'s phone variant is the only work surface already inside budget**, and
it is the best-designed surface in the product: collapsed stats, one section
label, ranked cards, one action per card, a "DO THIS FIRST" ribbon on rank 1, a
56px touch floor. **The desktop view should be rebuilt to look like the phone
view, not the other way round.**

---

## 6. Copy rules — already written, mostly honoured

Plain verbs, sentence case. Buttons say what happens. Enums humanised. **Never
show DB roles, RLS notes, table names or developer commentary in the UI.**

Two live violations:

- `workspace/page.tsx:43` — *"No current schedule for this job. Generate one, or
  run the demo bootstrap, to see the worklist."* — "demo bootstrap" is developer
  vocabulary in production UI.
- `/board` and `/profile` — *"coming in R2"* is the project's own explicitly
  banned dead control, shipped in the shop-floor navigation (AUD-040).

Add: **when a refusal is shown, name the reason in the user's language**, not the
code. The code goes in the inline note for support; the sentence is what the
supervisor reads. The 63-code table already has these sentences.

---

## 7. Sequencing

The design-system work has a dependency: **cut columns before raising type**, or
rows wrap and the layout breaks.

```
1. Token contrast (AUD-066, AUD-102)      ── independent, ship today
2. Column classification applied per table ── 04-09 tables
      └── 3. Typography floor (AUD-054)
             └── 4. Touch targets (AUD-067)   ── needs the row-height decision
5. One nav registry (AUD-011, AUD-012)     ── independent of 1-4
6. Extract useRun/RefusalNote               ── independent
7. States: loading.tsx on the six slow routes ── independent
8. Delete the dead viz components, or adopt them ── after the chart register decisions
```

Steps 1, 5, 6 and 7 can all start immediately and none of them blocks another.
